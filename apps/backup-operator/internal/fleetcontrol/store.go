package fleetcontrol

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	sharedfencing "github.com/supabase/supabase/apps/backup-operator/internal/shared/fencing"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*/*.sql
var fleetMigrations embed.FS

const CurrentSchemaVersion = 1

var ErrOperationNotFound = errors.New("Fleet operation not found")

type StoreDialect string

const (
	FleetSQLite   StoreDialect = "sqlite"
	FleetPostgres StoreDialect = "postgres"
)

type StoreIdentity struct {
	SystemIdentifier string
	DataDomain       string
}

type Store struct {
	db       *sql.DB
	dialect  StoreDialect
	identity StoreIdentity
	now      func() time.Time
}

type Operation struct {
	ID                 string    `json:"id"`
	ProjectRef         string    `json:"projectRef"`
	TargetID           string    `json:"targetId"`
	BindingID          string    `json:"bindingId"`
	Domain             string    `json:"domain"`
	Capability         string    `json:"capability"`
	State              string    `json:"state"`
	ProtocolMajor      int       `json:"protocolMajor"`
	ProtocolMinor      int       `json:"protocolMinor"`
	ExpectedGeneration int64     `json:"expectedGeneration"`
	InputSchema        string    `json:"inputSchema"`
	FencingToken       int64     `json:"fencingToken"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

type CreateOperationInput struct {
	Operation
	IdempotencyKey string
	TypedInput     json.RawMessage
	Preconditions  json.RawMessage
	Actor          string
	CorrelationID  string
}

type Event struct {
	Cursor int64
	Type   string
	Data   any
}

func OpenSQLite(ctx context.Context, path string, identity StoreIdentity) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db, dialect: FleetSQLite, identity: identity, now: time.Now}
	if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;"); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func OpenPostgres(ctx context.Context, dsn string, identity StoreIdentity) (*Store, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	store := &Store{db: db, dialect: FleetPostgres, identity: identity, now: time.Now}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	dir := "migrations/" + string(s.dialect)
	entries, err := fs.ReadDir(fleetMigrations, dir)
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		version, err := strconv.Atoi(strings.SplitN(entry.Name(), "_", 2)[0])
		if err != nil {
			return fmt.Errorf("Fleet migration %s: %w", entry.Name(), err)
		}
		var applied int
		check := "SELECT COUNT(*) FROM schema_migrations WHERE version=?"
		if s.dialect == FleetPostgres {
			check = "SELECT COUNT(*) FROM schema_migrations WHERE version=$1"
		}
		if err := s.db.QueryRowContext(ctx, check, version).Scan(&applied); err == nil && applied > 0 {
			continue
		}
		content, err := fleetMigrations.ReadFile(dir + "/" + entry.Name())
		if err != nil {
			return err
		}
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, string(content)); err == nil {
			insert := "INSERT INTO schema_migrations(version, applied_at_ms) VALUES(?, ?) ON CONFLICT(version) DO NOTHING"
			if s.dialect == FleetPostgres {
				insert = "INSERT INTO schema_migrations(version, applied_at_ms) VALUES($1, $2) ON CONFLICT(version) DO NOTHING"
			}
			_, err = tx.ExecContext(ctx, insert, version, s.now().UnixMilli())
		}
		if err != nil {
			tx.Rollback()
			return fmt.Errorf("apply Fleet migration %s: %w", entry.Name(), err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return s.ensureIdentity(ctx)
}

func (s *Store) ensureIdentity(ctx context.Context) error {
	if s.identity.SystemIdentifier == "" || s.identity.DataDomain == "" {
		return errors.New("Fleet store recovery-domain identity is required")
	}
	insert := "INSERT INTO store_identity(singleton, system_identifier, data_domain) VALUES(1, ?, ?) ON CONFLICT(singleton) DO NOTHING"
	if s.dialect == FleetPostgres {
		insert = "INSERT INTO store_identity(singleton, system_identifier, data_domain) VALUES(1, $1, $2) ON CONFLICT(singleton) DO NOTHING"
	}
	if _, err := s.db.ExecContext(ctx, insert, s.identity.SystemIdentifier, s.identity.DataDomain); err != nil {
		return err
	}
	var systemID, dataDomain string
	if err := s.db.QueryRowContext(ctx, "SELECT system_identifier, data_domain FROM store_identity WHERE singleton=1").Scan(&systemID, &dataDomain); err != nil {
		return err
	}
	if systemID != s.identity.SystemIdentifier || dataDomain != s.identity.DataDomain {
		return errors.New("configured Fleet store identity differs from persisted identity")
	}
	return nil
}

func (s *Store) SchemaVersion(ctx context.Context) (int, error) {
	var version int
	err := s.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(version),0) FROM schema_migrations").Scan(&version)
	return version, err
}

func (s *Store) CreateOperation(ctx context.Context, input CreateOperationInput) (Operation, bool, error) {
	if input.ID == "" || input.ProjectRef == "" || input.TargetID == "" || input.BindingID == "" || input.Capability == "" || input.IdempotencyKey == "" || input.Actor == "" || input.CorrelationID == "" {
		return Operation{}, false, errors.New("complete Fleet operation and audit identity is required")
	}
	if existing, err := s.getByIdempotency(ctx, input.ProjectRef, input.IdempotencyKey); err == nil {
		return existing, false, nil
	} else if !errors.Is(err, ErrOperationNotFound) {
		return Operation{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Operation{}, false, err
	}
	defer tx.Rollback()
	dialect := sharedfencing.SQLite
	if s.dialect == FleetPostgres {
		dialect = sharedfencing.Postgres
	}
	domainKey := input.ProjectRef + "/" + input.TargetID + "/" + input.BindingID
	token, err := (sharedfencing.Allocator{Dialect: dialect}).Allocate(ctx, tx, input.ID, domainKey)
	if err != nil {
		return Operation{}, false, err
	}
	now := s.now().UnixMilli()
	query := `INSERT INTO operations(id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,idempotency_key,fencing_token,expected_generation,input_schema,typed_input_json,preconditions_json,actor,correlation_id,created_at_ms,updated_at_ms)
VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_ref,idempotency_key) DO NOTHING`
	if s.dialect == FleetPostgres {
		query = `INSERT INTO operations(id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,idempotency_key,fencing_token,expected_generation,input_schema,typed_input_json,preconditions_json,actor,correlation_id,created_at_ms,updated_at_ms)
VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18) ON CONFLICT(project_ref,idempotency_key) DO NOTHING`
	}
	result, err := tx.ExecContext(ctx, query, input.ID, input.ProjectRef, input.TargetID, input.BindingID, input.Domain, input.Capability, input.ProtocolMajor, input.ProtocolMinor, input.IdempotencyKey, token, input.ExpectedGeneration, input.InputSchema, string(input.TypedInput), string(input.Preconditions), input.Actor, input.CorrelationID, now, now)
	if err != nil {
		return Operation{}, false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return Operation{}, false, err
	}
	if rows == 0 {
		if err := tx.Rollback(); err != nil {
			return Operation{}, false, err
		}
		existing, err := s.getByIdempotency(ctx, input.ProjectRef, input.IdempotencyKey)
		return existing, false, err
	}
	event := "INSERT INTO operation_events(operation_id,event_type,payload_json,created_at_ms) VALUES(?,'operation_queued','{}',?)"
	audit := "INSERT INTO audit_events(actor,project_ref,action,target_id,operation_id,correlation_id,payload_json,created_at_ms) VALUES(?,?,?,?,?,?,'{}',?)"
	if s.dialect == FleetPostgres {
		event = "INSERT INTO operation_events(operation_id,event_type,payload_json,created_at_ms) VALUES($1,'operation_queued','{}'::jsonb,$2)"
		audit = "INSERT INTO audit_events(actor,project_ref,action,target_id,operation_id,correlation_id,payload_json,created_at_ms) VALUES($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7)"
	}
	if _, err := tx.ExecContext(ctx, event, input.ID, now); err != nil {
		return Operation{}, false, err
	}
	if _, err := tx.ExecContext(ctx, audit, input.Actor, input.ProjectRef, "fleet.operation.create", input.TargetID, input.ID, input.CorrelationID, now); err != nil {
		return Operation{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return Operation{}, false, err
	}
	return s.GetOperation(ctx, input.ProjectRef, input.ID)
}

func (s *Store) GetOperation(ctx context.Context, projectRef, operationID string) (Operation, bool, error) {
	query := `SELECT id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,expected_generation,input_schema,fencing_token,created_at_ms,updated_at_ms FROM operations WHERE project_ref=? AND id=?`
	if s.dialect == FleetPostgres {
		query = `SELECT id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,expected_generation,input_schema,fencing_token,created_at_ms,updated_at_ms FROM operations WHERE project_ref=$1 AND id=$2`
	}
	operation, err := s.scanOperation(ctx, query, projectRef, operationID)
	return operation, err == nil, err
}

func (s *Store) getByIdempotency(ctx context.Context, projectRef, key string) (Operation, error) {
	query := `SELECT id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,expected_generation,input_schema,fencing_token,created_at_ms,updated_at_ms FROM operations WHERE project_ref=? AND idempotency_key=?`
	if s.dialect == FleetPostgres {
		query = strings.ReplaceAll(query, "?", "%s")
		query = fmt.Sprintf(query, "$1", "$2")
	}
	return s.scanOperation(ctx, query, projectRef, key)
}

func (s *Store) scanOperation(ctx context.Context, query string, args ...any) (Operation, error) {
	var operation Operation
	var created, updated int64
	err := s.db.QueryRowContext(ctx, query, args...).Scan(&operation.ID, &operation.ProjectRef, &operation.TargetID, &operation.BindingID, &operation.Domain, &operation.Capability, &operation.State, &operation.ProtocolMajor, &operation.ProtocolMinor, &operation.ExpectedGeneration, &operation.InputSchema, &operation.FencingToken, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Operation{}, ErrOperationNotFound
	}
	if err != nil {
		return Operation{}, err
	}
	operation.CreatedAt, operation.UpdatedAt = time.UnixMilli(created).UTC(), time.UnixMilli(updated).UTC()
	return operation, nil
}

func (s *Store) ReadEventsAfter(ctx context.Context, operationID string, cursor int64, limit int) ([]Event, error) {
	query := "SELECT id,event_type,payload_json FROM operation_events WHERE operation_id=? AND id>? ORDER BY id LIMIT ?"
	if s.dialect == FleetPostgres {
		query = "SELECT id,event_type,payload_json FROM operation_events WHERE operation_id=$1 AND id>$2 ORDER BY id LIMIT $3"
	}
	rows, err := s.db.QueryContext(ctx, query, operationID, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]Event, 0)
	for rows.Next() {
		var event Event
		var raw []byte
		if err := rows.Scan(&event.Cursor, &event.Type, &raw); err != nil {
			return nil, err
		}
		var payload any
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, err
		}
		event.Data = payload
		events = append(events, event)
	}
	return events, rows.Err()
}

func (s *Store) AuditCount(ctx context.Context, projectRef string) (int, error) {
	query := "SELECT COUNT(*) FROM audit_events WHERE project_ref=?"
	if s.dialect == FleetPostgres {
		query = "SELECT COUNT(*) FROM audit_events WHERE project_ref=$1"
	}
	var count int
	err := s.db.QueryRowContext(ctx, query, projectRef).Scan(&count)
	return count, err
}
