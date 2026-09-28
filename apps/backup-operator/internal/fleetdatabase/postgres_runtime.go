package fleetdatabase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// PostgresRuntime owns only the database settings explicitly represented by the
// database security contract. Credentials are never written to the state file.
//
// It works on any deployment that gives the Agent network access to Postgres
// and the Supavisor catalog (`_supabase._supavisor.tenants`): Compose reaches
// them on the project network, Kubernetes through the `db` and `supavisor`
// Services. StateRoot is Agent-owned storage and TLSCARoot an operator-managed
// directory of allowlisted CA files.
type PostgresRuntime struct {
	AdminDSN     string
	PoolerDSN    string
	StateRoot    string
	TLSCARoot    string
	PrimaryRole  string
	ReadOnlyRole string
}

type persistedState struct {
	SSL     SSLPolicy     `json:"ssl"`
	Network NetworkPolicy `json:"network"`
	Pooler  PoolerPolicy  `json:"pooler"`
}

func (r PostgresRuntime) Snapshot(ctx context.Context) (RuntimeSnapshot, error) {
	if err := r.validate(); err != nil {
		return RuntimeSnapshot{}, err
	}
	connection, err := pgx.Connect(ctx, withDatabase(r.AdminDSN, "_supabase"))
	if err != nil {
		return RuntimeSnapshot{}, errors.New("connect to Supavisor catalog")
	}
	defer connection.Close(ctx)
	var ssl SSLPolicy
	var cidrs []string
	var pooler PoolerPolicy
	var verify *string
	var ca []byte
	err = connection.QueryRow(ctx, `select enforce_ssl, upstream_verify, upstream_tls_ca, coalesce(allow_list, array[]::varchar[]), default_pool_size, default_max_clients from _supavisor.tenants order by inserted_at limit 1`).Scan(
		&ssl.Enforced, &verify, &ca, &cidrs, &pooler.DefaultPoolSize, &pooler.MaxClientConnections,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return RuntimeSnapshot{}, errors.New("Supavisor tenant is not initialized")
	}
	if err != nil {
		return RuntimeSnapshot{}, errors.New("read Supavisor database security settings")
	}
	if ssl.Enforced && len(ca) > 0 {
		ssl.CAReference = r.persistedCAReference()
	}
	if len(cidrs) == 2 && cidrs[0] == "0.0.0.0/0" && cidrs[1] == "::/0" {
		cidrs = []string{}
	}
	if state, readErr := r.readState(); readErr == nil {
		ssl.CAReference = state.SSL.CAReference
		cidrs = append([]string(nil), state.Network.AllowedCIDRs...)
	}
	return RuntimeSnapshot{SSL: ssl, Network: NetworkPolicy{AllowedCIDRs: cidrs}, Pooler: pooler}, nil
}

func (r PostgresRuntime) Apply(ctx context.Context, document Document) error {
	if err := r.validate(); err != nil {
		return err
	}
	var ca []byte
	var err error
	if document.SSL.Enforced {
		ca, err = r.readCA(document.SSL.CAReference)
		if err != nil {
			return err
		}
	}
	connection, err := pgx.Connect(ctx, withDatabase(r.AdminDSN, "_supabase"))
	if err != nil {
		return errors.New("connect to Supavisor catalog")
	}
	defer connection.Close(ctx)
	var verify *string
	if document.SSL.Enforced {
		value := "peer"
		verify = &value
	}
	allowedCIDRs := document.Network.AllowedCIDRs
	if len(allowedCIDRs) == 0 {
		allowedCIDRs = []string{"0.0.0.0/0", "::/0"}
	}
	tag, err := connection.Exec(ctx, `update _supavisor.tenants set enforce_ssl=$1, upstream_ssl=$1, upstream_verify=$2, upstream_tls_ca=$3, allow_list=$4, default_pool_size=$5, default_max_clients=$6, updated_at=now()`,
		document.SSL.Enforced, verify, ca, allowedCIDRs, document.Pooler.DefaultPoolSize, document.Pooler.MaxClientConnections)
	if err != nil {
		return fmt.Errorf("apply Supavisor database security settings: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errors.New("apply Supavisor database security settings: no tenant row")
	}
	if document.Rotation != nil {
		if err := r.rotate(ctx, document.Rotation.Role, document.Rotation.CurrentPassword, document.Rotation.NewPassword); err != nil {
			return err
		}
	}
	if err := r.writeState(persistedState{SSL: document.SSL, Network: document.Network, Pooler: document.Pooler}); err != nil {
		return err
	}
	return nil
}

func (r PostgresRuntime) Probe(ctx context.Context, document Document) error {
	connection, err := pgx.Connect(ctx, r.AdminDSN)
	if err != nil {
		return errors.New("database health probe failed")
	}
	if err = connection.Ping(ctx); err != nil {
		connection.Close(ctx)
		return errors.New("database health probe failed")
	}
	connection.Close(ctx)
	if document.Rotation != nil {
		if err := r.probeRole(ctx, r.role(document.Rotation.Role), document.Rotation.NewPassword, r.AdminDSN); err != nil {
			return errors.New("rotated database credential probe failed")
		}
	}
	if strings.TrimSpace(r.PoolerDSN) != "" {
		probeDSN := r.PoolerDSN
		if document.Rotation != nil && document.Rotation.Role == PasswordRolePrimary {
			probeDSN = withPassword(probeDSN, document.Rotation.NewPassword)
		}
		if err := r.probePoolerWithRetry(ctx, probeDSN); err != nil {
			return errors.New("Supavisor health probe failed")
		}
	}
	return nil
}

func (r PostgresRuntime) probePoolerWithRetry(ctx context.Context, dsn string) error {
	var err error
	for attempt := 0; attempt < 20; attempt++ {
		if err = r.probeRole(ctx, "", "", dsn); err == nil {
			return nil
		}
		timer := time.NewTimer(250 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return err
}

func (r PostgresRuntime) Restore(ctx context.Context, snapshot RuntimeSnapshot, rotation *PasswordChange) error {
	document := Document{SSL: snapshot.SSL, Network: snapshot.Network, Pooler: snapshot.Pooler}
	if err := r.Apply(ctx, document); err != nil {
		return err
	}
	if rotation != nil {
		if err := r.rotate(ctx, rotation.Role, rotation.NewPassword, rotation.CurrentPassword); err != nil {
			return err
		}
	}
	return nil
}

func (r PostgresRuntime) validate() error {
	if strings.TrimSpace(r.AdminDSN) == "" || strings.TrimSpace(r.StateRoot) == "" || strings.TrimSpace(r.PrimaryRole) == "" || strings.TrimSpace(r.ReadOnlyRole) == "" {
		return errors.New("complete database runtime configuration is required")
	}
	return nil
}

func (r PostgresRuntime) role(role PasswordRole) string {
	if role == PasswordRoleReadOnly {
		return r.ReadOnlyRole
	}
	return r.PrimaryRole
}

func (r PostgresRuntime) rotate(ctx context.Context, role PasswordRole, current, next string) error {
	name := r.role(role)
	if err := r.probeRole(ctx, name, current, r.AdminDSN); err != nil {
		return errors.New("current database credential verification failed")
	}
	connection, err := pgx.Connect(ctx, r.AdminDSN)
	if err != nil {
		return errors.New("connect to database credential authority")
	}
	defer connection.Close(ctx)
	var statement string
	if err := connection.QueryRow(ctx, `select format('alter role %I password %L', $1::text, $2::text)`, name, next).Scan(&statement); err != nil {
		return fmt.Errorf("prepare database credential rotation: %w", err)
	}
	if _, err := connection.Exec(ctx, statement); err != nil {
		return errors.New("rotate database credential")
	}
	return nil
}

func (r PostgresRuntime) probeRole(ctx context.Context, role, password, dsn string) error {
	if role != "" {
		dsn = withCredential(dsn, role, password)
	}
	connection, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer connection.Close(ctx)
	return connection.Ping(ctx)
}

func withDatabase(dsn, database string) string {
	parsed, err := url.Parse(dsn)
	if err != nil {
		return dsn
	}
	parsed.Path = "/" + database
	return parsed.String()
}

func withCredential(dsn, role, password string) string {
	parsed, err := url.Parse(dsn)
	if err != nil {
		return dsn
	}
	parsed.User = url.UserPassword(role, password)
	return parsed.String()
}

func withPassword(dsn, password string) string {
	parsed, err := url.Parse(dsn)
	if err != nil || parsed.User == nil {
		return dsn
	}
	parsed.User = url.UserPassword(parsed.User.Username(), password)
	return parsed.String()
}

func (r PostgresRuntime) statePath() string {
	return filepath.Join(r.StateRoot, "database-security.json")
}

func (r PostgresRuntime) readState() (persistedState, error) {
	raw, err := os.ReadFile(r.statePath())
	if err != nil {
		return persistedState{}, err
	}
	var state persistedState
	if json.Unmarshal(raw, &state) != nil {
		return persistedState{}, errors.New("database security state is invalid")
	}
	return state, nil
}

func (r PostgresRuntime) writeState(state persistedState) error {
	if err := os.MkdirAll(r.StateRoot, 0o700); err != nil {
		return errors.New("create database security state root")
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return errors.New("encode database security state")
	}
	temporary := r.statePath() + ".tmp"
	if err := os.WriteFile(temporary, raw, 0o600); err != nil {
		return errors.New("stage database security state")
	}
	if err := os.Rename(temporary, r.statePath()); err != nil {
		return errors.New("activate database security state")
	}
	return nil
}

func (r PostgresRuntime) readCA(reference string) ([]byte, error) {
	if strings.TrimSpace(r.TLSCARoot) == "" || filepath.Base(reference) != reference || strings.Contains(reference, "..") {
		return nil, errors.New("TLS CA reference is outside the operator allowlist")
	}
	raw, err := os.ReadFile(filepath.Join(r.TLSCARoot, reference))
	if err != nil || len(raw) == 0 || len(raw) > 1<<20 {
		return nil, errors.New("TLS CA reference could not be resolved")
	}
	return raw, nil
}

func (r PostgresRuntime) persistedCAReference() string {
	state, err := r.readState()
	if err == nil {
		return state.SSL.CAReference
	}
	return ""
}

func (r PostgresRuntime) String() string {
	return fmt.Sprintf("database runtime (%s, %s)", r.PrimaryRole, r.ReadOnlyRole)
}
