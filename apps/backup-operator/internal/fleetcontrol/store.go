package fleetcontrol

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

const CurrentSchemaVersion = 11

const operationDeadline = 15 * time.Minute

var ErrOperationNotFound = errors.New("Fleet operation not found")
var ErrMigrationChecksum = errors.New("Fleet migration checksum mismatch")
var ErrOperationBinding = errors.New("Fleet operation binding mismatch")
var ErrOperationCapability = errors.New("Fleet operation capability unavailable")
var ErrOperationState = errors.New("Fleet operation state conflict")
var ErrArtifactNotFound = errors.New("Fleet function artifact not found")

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
	db              *sql.DB
	dialect         StoreDialect
	identity        StoreIdentity
	now             func() time.Time
	capacity        CapacityPolicy
	liveness        LivenessPolicy
	sensitiveCipher cipher.AEAD
}

type Operation struct {
	ID                 string             `json:"id"`
	ProjectRef         string             `json:"projectRef"`
	TargetID           string             `json:"targetId"`
	BindingID          string             `json:"bindingId"`
	Domain             string             `json:"domain"`
	Capability         string             `json:"capability"`
	State              string             `json:"state"`
	ProtocolMajor      int                `json:"protocolMajor"`
	ProtocolMinor      int                `json:"protocolMinor"`
	ExpectedGeneration int64              `json:"expectedGeneration"`
	DesiredRevision    string             `json:"desiredRevision"`
	DesiredDigest      string             `json:"desiredDigest"`
	InputSchema        string             `json:"inputSchema"`
	FencingToken       int64              `json:"fencingToken"`
	TaskID             string             `json:"taskId,omitempty"`
	AgentID            string             `json:"agentId,omitempty"`
	EvidenceSchema     string             `json:"evidenceSchema,omitempty"`
	Evidence           any                `json:"evidence,omitempty"`
	ErrorCode          string             `json:"errorCode,omitempty"`
	Attempts           int                `json:"attempts"`
	CorrelationID      string             `json:"correlationId"`
	DeadlineAt         time.Time          `json:"deadlineAt"`
	StartedAt          time.Time          `json:"startedAt,omitempty"`
	FinishedAt         time.Time          `json:"finishedAt,omitempty"`
	AttemptHistory     []OperationAttempt `json:"attemptHistory"`
	CreatedAt          time.Time          `json:"createdAt"`
	UpdatedAt          time.Time          `json:"updatedAt"`
}

type OperationAttempt struct {
	Attempt        int       `json:"attempt"`
	TaskID         string    `json:"taskId"`
	AgentID        string    `json:"agentId"`
	State          string    `json:"state"`
	EvidenceSchema string    `json:"evidenceSchema,omitempty"`
	Evidence       any       `json:"evidence,omitempty"`
	ErrorCode      string    `json:"errorCode,omitempty"`
	StartedAt      time.Time `json:"startedAt"`
	FinishedAt     time.Time `json:"finishedAt,omitempty"`
}

type CreateOperationInput struct {
	Operation
	IdempotencyKey            string
	TypedInput                json.RawMessage
	SnapshotCanonical         string
	Preconditions             json.RawMessage
	Actor                     string
	CorrelationID             string
	Sensitive                 bool
	RedactedTypedInput        json.RawMessage
	RedactedSnapshotCanonical string
}

func (s *Store) ConfigureSensitiveOperationKey(secret []byte) error {
	if len(secret) < 32 {
		return errors.New("sensitive operation encryption secret must contain at least 32 bytes")
	}
	key := sha256.Sum256(append([]byte("supabase-fleet-sensitive-operation-v1\x00"), secret...))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return err
	}
	s.sensitiveCipher, err = cipher.NewGCM(block)
	return err
}

func (s *Store) encryptSensitiveInput(plaintext []byte) ([]byte, []byte, error) {
	if s.sensitiveCipher == nil {
		return nil, nil, errors.New("sensitive operation encryption is not configured")
	}
	nonce := make([]byte, s.sensitiveCipher.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, nil, err
	}
	return s.sensitiveCipher.Seal(nil, nonce, plaintext, nil), nonce, nil
}

func (s *Store) decryptSensitiveInput(ciphertext, nonce []byte) ([]byte, error) {
	if s.sensitiveCipher == nil {
		return nil, errors.New("sensitive operation encryption is not configured")
	}
	return s.sensitiveCipher.Open(nil, nonce, ciphertext, nil)
}

type Event struct {
	Cursor int64
	Type   string
	Data   any
}

type ClaimedOperation struct {
	Operation
	IdempotencyKey string
	TypedInput     json.RawMessage
	Preconditions  json.RawMessage
}

type AgentSessionIdentity struct {
	AgentID      string
	ProjectRef   string
	TargetID     string
	BindingID    string
	Capabilities []string
}

type CompleteOperationInput struct {
	TaskID         string
	AgentID        string
	Succeeded      bool
	EvidenceSchema string
	Evidence       json.RawMessage
	ErrorCode      string
	TerminalState  string
}

func OpenSQLite(ctx context.Context, path string, identity StoreIdentity) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db, dialect: FleetSQLite, identity: identity, now: time.Now, capacity: DefaultCapacityPolicy(), liveness: DefaultLivenessPolicy()}
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
	store := &Store{db: db, dialect: FleetPostgres, identity: identity, now: time.Now, capacity: DefaultCapacityPolicy(), liveness: DefaultLivenessPolicy()}
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
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	locked := false
	defer func() {
		if conn == nil {
			return
		}
		if locked {
			_, _ = conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock(19088743, 6)")
		}
		_ = conn.Close()
	}()
	if s.dialect == FleetPostgres {
		if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock(19088743, 6)"); err != nil {
			return fmt.Errorf("acquire Fleet migration lock: %w", err)
		}
		locked = true
	}
	if err := s.ensureMigrationLedger(ctx, conn); err != nil {
		return err
	}
	dir := "migrations/" + string(s.dialect)
	entries, err := fs.ReadDir(fleetMigrations, dir)
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	expectedMigrations := make(map[int]string, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		version, err := strconv.Atoi(strings.SplitN(entry.Name(), "_", 2)[0])
		if err != nil {
			return fmt.Errorf("Fleet migration %s: %w", entry.Name(), err)
		}
		expectedMigrations[version] = entry.Name()
		content, err := fleetMigrations.ReadFile(dir + "/" + entry.Name())
		if err != nil {
			return err
		}
		digest := sha256.Sum256(content)
		checksum := hex.EncodeToString(digest[:])
		var appliedName, appliedChecksum sql.NullString
		check := "SELECT name, checksum FROM schema_migrations WHERE version=?"
		if s.dialect == FleetPostgres {
			check = "SELECT name, checksum FROM schema_migrations WHERE version=$1"
		}
		err = conn.QueryRowContext(ctx, check, version).Scan(&appliedName, &appliedChecksum)
		if err == nil {
			if !appliedName.Valid || !appliedChecksum.Valid {
				if err := s.adoptLegacyMigration(ctx, conn, version, entry.Name(), checksum); err != nil {
					return err
				}
				continue
			}
			if appliedName.String != entry.Name() || appliedChecksum.String != checksum {
				return fmt.Errorf("%w: %s", ErrMigrationChecksum, entry.Name())
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, string(content)); err == nil {
			insert := "INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES(?, ?, ?, ?)"
			if s.dialect == FleetPostgres {
				insert = "INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES($1, $2, $3, $4)"
			}
			_, err = tx.ExecContext(ctx, insert, version, entry.Name(), checksum, s.now().UnixMilli())
		}
		if err != nil {
			tx.Rollback()
			return fmt.Errorf("apply Fleet migration %s: %w", entry.Name(), err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	if err := s.ensureNoRemovedMigrations(ctx, conn, expectedMigrations); err != nil {
		return err
	}
	if locked {
		if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_unlock(19088743, 6)"); err != nil {
			return err
		}
		locked = false
	}
	if err := conn.Close(); err != nil {
		return err
	}
	conn = nil
	return s.ensureIdentity(ctx)
}

func (s *Store) ensureNoRemovedMigrations(ctx context.Context, conn *sql.Conn, expected map[int]string) error {
	rows, err := conn.QueryContext(ctx, "SELECT version, name FROM schema_migrations")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var version int
		var name sql.NullString
		if err := rows.Scan(&version, &name); err != nil {
			return err
		}
		expectedName, ok := expected[version]
		if !ok || !name.Valid || name.String != expectedName {
			return fmt.Errorf("%w: applied Fleet migration version %d is missing from the binary", ErrMigrationChecksum, version)
		}
	}
	return rows.Err()
}

func (s *Store) ensureMigrationLedger(ctx context.Context, conn *sql.Conn) error {
	create := `CREATE TABLE IF NOT EXISTS schema_migrations (
version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at_ms INTEGER NOT NULL)`
	if s.dialect == FleetPostgres {
		create = `CREATE TABLE IF NOT EXISTS schema_migrations (
version BIGINT PRIMARY KEY, name TEXT, checksum TEXT, applied_at_ms BIGINT NOT NULL)`
	}
	if _, err := conn.ExecContext(ctx, create); err != nil {
		return fmt.Errorf("create Fleet migration ledger: %w", err)
	}
	for _, column := range []string{"name", "checksum"} {
		exists, err := s.migrationLedgerColumnExists(ctx, conn, column)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		if _, err := conn.ExecContext(ctx, "ALTER TABLE schema_migrations ADD COLUMN "+column+" TEXT"); err != nil {
			return fmt.Errorf("upgrade Fleet migration ledger column %s: %w", column, err)
		}
	}
	return nil
}

func (s *Store) migrationLedgerColumnExists(ctx context.Context, conn *sql.Conn, column string) (bool, error) {
	if s.dialect == FleetPostgres {
		var exists bool
		err := conn.QueryRowContext(ctx, `SELECT EXISTS (
SELECT 1 FROM information_schema.columns
WHERE table_schema=current_schema() AND table_name='schema_migrations' AND column_name=$1
)`, column).Scan(&exists)
		return exists, err
	}
	rows, err := conn.QueryContext(ctx, "PRAGMA table_info(schema_migrations)")
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, dataType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func (s *Store) adoptLegacyMigration(ctx context.Context, conn *sql.Conn, version int, name, checksum string) error {
	query := "UPDATE schema_migrations SET name=?, checksum=? WHERE version=? AND name IS NULL AND checksum IS NULL"
	if s.dialect == FleetPostgres {
		query = "UPDATE schema_migrations SET name=$1, checksum=$2 WHERE version=$3 AND name IS NULL AND checksum IS NULL"
	}
	result, err := conn.ExecContext(ctx, query, name, checksum, version)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil || rows != 1 {
		return fmt.Errorf("%w: cannot adopt legacy migration %s", ErrMigrationChecksum, name)
	}
	return nil
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
	if input.ID == "" || input.ProjectRef == "" || input.TargetID == "" || input.BindingID == "" || input.Capability == "" || input.DesiredRevision == "" || input.DesiredDigest == "" || input.SnapshotCanonical == "" || input.IdempotencyKey == "" || input.Actor == "" || input.CorrelationID == "" {
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
	if err := s.enforceOperationQuotaTx(ctx, tx, input.ProjectRef, input.TargetID, input.BindingID); err != nil {
		return Operation{}, false, err
	}
	dialect := sharedfencing.SQLite
	if s.dialect == FleetPostgres {
		dialect = sharedfencing.Postgres
	}
	domainKey := input.ProjectRef + "/" + input.TargetID + "/" + input.BindingID
	token, err := (sharedfencing.Allocator{Dialect: dialect}).Allocate(ctx, tx, input.ID, domainKey)
	if err != nil {
		return Operation{}, false, err
	}
	now := s.now().UTC()
	deadline := now.Add(operationDeadline)
	storedInput := append(json.RawMessage(nil), input.TypedInput...)
	storedSnapshot := input.SnapshotCanonical
	var inputCiphertext, inputNonce []byte
	if input.Sensitive {
		if len(input.RedactedTypedInput) == 0 || !json.Valid(input.RedactedTypedInput) || input.RedactedSnapshotCanonical == "" {
			return Operation{}, false, errors.New("sensitive operation requires a redacted durable payload")
		}
		inputCiphertext, inputNonce, err = s.encryptSensitiveInput(input.TypedInput)
		if err != nil {
			return Operation{}, false, err
		}
		storedInput = append(json.RawMessage(nil), input.RedactedTypedInput...)
		storedSnapshot = input.RedactedSnapshotCanonical
	}
	query := `INSERT INTO operations(id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,idempotency_key,fencing_token,expected_generation,desired_revision,desired_digest,snapshot_canonical,input_schema,typed_input_json,preconditions_json,actor,correlation_id,created_at_ms,updated_at_ms,deadline_at_ms,sensitive,input_ciphertext,input_nonce)
VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_ref,idempotency_key) DO NOTHING`
	if s.dialect == FleetPostgres {
		query = `INSERT INTO operations(id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,idempotency_key,fencing_token,expected_generation,desired_revision,desired_digest,snapshot_canonical,input_schema,typed_input_json,preconditions_json,actor,correlation_id,created_at_ms,updated_at_ms,deadline_at_ms,sensitive,input_ciphertext,input_nonce)
VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25) ON CONFLICT(project_ref,idempotency_key) DO NOTHING`
	}
	result, err := tx.ExecContext(ctx, query, input.ID, input.ProjectRef, input.TargetID, input.BindingID, input.Domain, input.Capability, input.ProtocolMajor, input.ProtocolMinor, input.IdempotencyKey, token, input.ExpectedGeneration, input.DesiredRevision, input.DesiredDigest, storedSnapshot, input.InputSchema, string(storedInput), string(input.Preconditions), input.Actor, input.CorrelationID, now.UnixMilli(), now.UnixMilli(), deadline.UnixMilli(), input.Sensitive, inputCiphertext, inputNonce)
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
	if _, err := tx.ExecContext(ctx, event, input.ID, now.UnixMilli()); err != nil {
		return Operation{}, false, err
	}
	if _, err := tx.ExecContext(ctx, audit, input.Actor, input.ProjectRef, "fleet.operation.create", input.TargetID, input.ID, input.CorrelationID, now.UnixMilli()); err != nil {
		return Operation{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return Operation{}, false, err
	}
	return s.GetOperation(ctx, input.ProjectRef, input.ID)
}

func (s *Store) GetOperation(ctx context.Context, projectRef, operationID string) (Operation, bool, error) {
	if err := s.ExpireOperations(ctx); err != nil {
		return Operation{}, false, err
	}
	query := `SELECT id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,expected_generation,desired_revision,desired_digest,input_schema,fencing_token,COALESCE(task_id,''),COALESCE(agent_id,''),COALESCE(evidence_schema,''),COALESCE(evidence_json,'{}'),COALESCE(error_code,''),attempts,correlation_id,deadline_at_ms,COALESCE(started_at_ms,0),COALESCE(finished_at_ms,0),created_at_ms,updated_at_ms FROM operations WHERE project_ref=? AND id=?`
	if s.dialect == FleetPostgres {
		query = `SELECT id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,expected_generation,desired_revision,desired_digest,input_schema,fencing_token,COALESCE(task_id,''),COALESCE(agent_id,''),COALESCE(evidence_schema,''),COALESCE(evidence_json,'{}'::jsonb),COALESCE(error_code,''),attempts,correlation_id,deadline_at_ms,COALESCE(started_at_ms,0),COALESCE(finished_at_ms,0),created_at_ms,updated_at_ms FROM operations WHERE project_ref=$1 AND id=$2`
	}
	operation, err := s.scanOperation(ctx, query, projectRef, operationID)
	if err == nil {
		operation.AttemptHistory, err = s.readOperationAttempts(ctx, operation.ID)
	}
	return operation, err == nil, err
}

func (s *Store) getByIdempotency(ctx context.Context, projectRef, key string) (Operation, error) {
	query := `SELECT id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,expected_generation,desired_revision,desired_digest,input_schema,fencing_token,COALESCE(task_id,''),COALESCE(agent_id,''),COALESCE(evidence_schema,''),COALESCE(evidence_json,'{}'),COALESCE(error_code,''),attempts,correlation_id,deadline_at_ms,COALESCE(started_at_ms,0),COALESCE(finished_at_ms,0),created_at_ms,updated_at_ms FROM operations WHERE project_ref=? AND idempotency_key=?`
	if s.dialect == FleetPostgres {
		query = `SELECT id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,expected_generation,desired_revision,desired_digest,input_schema,fencing_token,COALESCE(task_id,''),COALESCE(agent_id,''),COALESCE(evidence_schema,''),COALESCE(evidence_json,'{}'::jsonb),COALESCE(error_code,''),attempts,correlation_id,deadline_at_ms,COALESCE(started_at_ms,0),COALESCE(finished_at_ms,0),created_at_ms,updated_at_ms FROM operations WHERE project_ref=$1 AND idempotency_key=$2`
	}
	operation, err := s.scanOperation(ctx, query, projectRef, key)
	if err == nil {
		operation.AttemptHistory, err = s.readOperationAttempts(ctx, operation.ID)
	}
	return operation, err
}

func (s *Store) GetOperationByIdempotency(ctx context.Context, projectRef, key string) (Operation, error) {
	if err := s.ExpireOperations(ctx); err != nil {
		return Operation{}, err
	}
	return s.getByIdempotency(ctx, projectRef, key)
}

func (s *Store) scanOperation(ctx context.Context, query string, args ...any) (Operation, error) {
	var operation Operation
	var deadline, started, finished, created, updated int64
	var evidence []byte
	err := s.db.QueryRowContext(ctx, query, args...).Scan(&operation.ID, &operation.ProjectRef, &operation.TargetID, &operation.BindingID, &operation.Domain, &operation.Capability, &operation.State, &operation.ProtocolMajor, &operation.ProtocolMinor, &operation.ExpectedGeneration, &operation.DesiredRevision, &operation.DesiredDigest, &operation.InputSchema, &operation.FencingToken, &operation.TaskID, &operation.AgentID, &operation.EvidenceSchema, &evidence, &operation.ErrorCode, &operation.Attempts, &operation.CorrelationID, &deadline, &started, &finished, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Operation{}, ErrOperationNotFound
	}
	if err != nil {
		return Operation{}, err
	}
	operation.DeadlineAt = time.UnixMilli(deadline).UTC()
	operation.CreatedAt, operation.UpdatedAt = time.UnixMilli(created).UTC(), time.UnixMilli(updated).UTC()
	if started > 0 {
		operation.StartedAt = time.UnixMilli(started).UTC()
	}
	if finished > 0 {
		operation.FinishedAt = time.UnixMilli(finished).UTC()
	}
	if len(evidence) > 0 && string(evidence) != "{}" {
		if err := json.Unmarshal(evidence, &operation.Evidence); err != nil {
			return Operation{}, err
		}
	}
	return operation, nil
}

func (s *Store) readOperationAttempts(ctx context.Context, operationID string) ([]OperationAttempt, error) {
	query := `SELECT attempt,task_id,agent_id,state,COALESCE(evidence_schema,''),COALESCE(evidence_json,'{}'),COALESCE(error_code,''),started_at_ms,COALESCE(finished_at_ms,0) FROM operation_attempts WHERE operation_id=? ORDER BY attempt`
	if s.dialect == FleetPostgres {
		query = `SELECT attempt,task_id,agent_id,state,COALESCE(evidence_schema,''),COALESCE(evidence_json,'{}'::jsonb),COALESCE(error_code,''),started_at_ms,COALESCE(finished_at_ms,0) FROM operation_attempts WHERE operation_id=$1 ORDER BY attempt`
	}
	rows, err := s.db.QueryContext(ctx, query, operationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	attempts := make([]OperationAttempt, 0)
	for rows.Next() {
		var attempt OperationAttempt
		var evidence []byte
		var started, finished int64
		if err := rows.Scan(&attempt.Attempt, &attempt.TaskID, &attempt.AgentID, &attempt.State, &attempt.EvidenceSchema, &evidence, &attempt.ErrorCode, &started, &finished); err != nil {
			return nil, err
		}
		attempt.StartedAt = time.UnixMilli(started).UTC()
		if finished > 0 {
			attempt.FinishedAt = time.UnixMilli(finished).UTC()
		}
		if len(evidence) > 0 && string(evidence) != "{}" {
			if err := json.Unmarshal(evidence, &attempt.Evidence); err != nil {
				return nil, err
			}
		}
		attempts = append(attempts, attempt)
	}
	return attempts, rows.Err()
}

func (s *Store) ExpireOperations(ctx context.Context) error {
	now := s.now().UTC().UnixMilli()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	query := "SELECT id,project_ref,target_id,correlation_id,COALESCE(task_id,'') FROM operations WHERE state IN ('queued','running') AND deadline_at_ms<=?"
	if s.dialect == FleetPostgres {
		query = "SELECT id,project_ref,target_id,correlation_id,COALESCE(task_id,'') FROM operations WHERE state IN ('queued','running') AND deadline_at_ms<=$1 FOR UPDATE"
	}
	rows, err := tx.QueryContext(ctx, query, now)
	if err != nil {
		return err
	}
	type expiredOperation struct{ id, projectRef, targetID, correlationID, taskID string }
	expired := make([]expiredOperation, 0)
	for rows.Next() {
		var operation expiredOperation
		if err := rows.Scan(&operation.id, &operation.projectRef, &operation.targetID, &operation.correlationID, &operation.taskID); err != nil {
			rows.Close()
			return err
		}
		expired = append(expired, operation)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, operation := range expired {
		update := "UPDATE operations SET state='timed_out',error_code='operation_timed_out',finished_at_ms=?,updated_at_ms=? WHERE id=? AND state IN ('queued','running')"
		if s.dialect == FleetPostgres {
			update = "UPDATE operations SET state='timed_out',error_code='operation_timed_out',finished_at_ms=$1,updated_at_ms=$2 WHERE id=$3 AND state IN ('queued','running')"
		}
		result, err := tx.ExecContext(ctx, update, now, now, operation.id)
		if err != nil {
			return err
		}
		if affected, err := result.RowsAffected(); err != nil || affected != 1 {
			continue
		}
		if operation.taskID != "" {
			attempt := "UPDATE operation_attempts SET state='timed_out',error_code='operation_timed_out',finished_at_ms=? WHERE task_id=? AND state='running'"
			if s.dialect == FleetPostgres {
				attempt = "UPDATE operation_attempts SET state='timed_out',error_code='operation_timed_out',finished_at_ms=$1 WHERE task_id=$2 AND state='running'"
			}
			if _, err := tx.ExecContext(ctx, attempt, now, operation.taskID); err != nil {
				return err
			}
		}
		if err := s.recordOperationTransitionTx(ctx, tx, operation.id, operation.projectRef, operation.targetID, "system:fleet-control", operation.correlationID, "timed_out", "fleet.operation.timeout", now, map[string]any{"errorCode": "operation_timed_out"}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) CancelOperation(ctx context.Context, projectRef, operationID, actor, correlationID string) error {
	if projectRef == "" || operationID == "" || actor == "" || correlationID == "" {
		return errors.New("complete operation cancellation identity is required")
	}
	return s.transitionQueuedOperation(ctx, projectRef, operationID, actor, correlationID, "cancelled", "fleet.operation.cancel")
}

func (s *Store) RetryOperation(ctx context.Context, projectRef, operationID, actor, correlationID string) error {
	if projectRef == "" || operationID == "" || actor == "" || correlationID == "" {
		return errors.New("complete operation retry identity is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var targetID string
	selectTarget := "SELECT target_id FROM operations WHERE project_ref=? AND id=?"
	if s.dialect == FleetPostgres {
		selectTarget = "SELECT target_id FROM operations WHERE project_ref=$1 AND id=$2 FOR UPDATE"
	}
	if err := tx.QueryRowContext(ctx, selectTarget, projectRef, operationID).Scan(&targetID); errors.Is(err, sql.ErrNoRows) {
		return ErrOperationNotFound
	} else if err != nil {
		return err
	}
	now := s.now().UTC()
	update := "UPDATE operations SET state='queued',task_id=NULL,agent_id=NULL,evidence_schema=NULL,evidence_json=NULL,error_code=NULL,started_at_ms=NULL,finished_at_ms=NULL,deadline_at_ms=?,updated_at_ms=? WHERE project_ref=? AND id=? AND state='failed'"
	if s.dialect == FleetPostgres {
		update = "UPDATE operations SET state='queued',task_id=NULL,agent_id=NULL,evidence_schema=NULL,evidence_json=NULL,error_code=NULL,started_at_ms=NULL,finished_at_ms=NULL,deadline_at_ms=$1,updated_at_ms=$2 WHERE project_ref=$3 AND id=$4 AND state='failed'"
	}
	result, err := tx.ExecContext(ctx, update, now.Add(operationDeadline).UnixMilli(), now.UnixMilli(), projectRef, operationID)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		return ErrOperationState
	}
	if err := s.recordOperationTransitionTx(ctx, tx, operationID, projectRef, targetID, actor, correlationID, "queued", "fleet.operation.retry", now.UnixMilli(), map[string]any{"reason": "explicit_retry"}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) transitionQueuedOperation(ctx context.Context, projectRef, operationID, actor, correlationID, state, action string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var targetID string
	selectTarget := "SELECT target_id FROM operations WHERE project_ref=? AND id=?"
	if s.dialect == FleetPostgres {
		selectTarget = "SELECT target_id FROM operations WHERE project_ref=$1 AND id=$2 FOR UPDATE"
	}
	if err := tx.QueryRowContext(ctx, selectTarget, projectRef, operationID).Scan(&targetID); errors.Is(err, sql.ErrNoRows) {
		return ErrOperationNotFound
	} else if err != nil {
		return err
	}
	now := s.now().UTC().UnixMilli()
	update := "UPDATE operations SET state=?,finished_at_ms=?,updated_at_ms=? WHERE project_ref=? AND id=? AND state='queued'"
	if s.dialect == FleetPostgres {
		update = "UPDATE operations SET state=$1,finished_at_ms=$2,updated_at_ms=$3 WHERE project_ref=$4 AND id=$5 AND state='queued'"
	}
	result, err := tx.ExecContext(ctx, update, state, now, now, projectRef, operationID)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		return ErrOperationState
	}
	if err := s.recordOperationTransitionTx(ctx, tx, operationID, projectRef, targetID, actor, correlationID, state, action, now, map[string]any{"action": action}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) recordOperationTransitionTx(ctx context.Context, tx *sql.Tx, operationID, projectRef, targetID, actor, correlationID, state, auditAction string, now int64, payloadValue map[string]any) error {
	payload, _ := json.Marshal(payloadValue)
	event := "INSERT INTO operation_events(operation_id,event_type,payload_json,created_at_ms) VALUES(?,?,?,?)"
	audit := "INSERT INTO audit_events(actor,project_ref,action,target_id,operation_id,correlation_id,payload_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?)"
	if s.dialect == FleetPostgres {
		event = "INSERT INTO operation_events(operation_id,event_type,payload_json,created_at_ms) VALUES($1,$2,$3::jsonb,$4)"
		audit = "INSERT INTO audit_events(actor,project_ref,action,target_id,operation_id,correlation_id,payload_json,created_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)"
	}
	if _, err := tx.ExecContext(ctx, event, operationID, "operation_"+state, string(payload), now); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, audit, actor, projectRef, auditAction, targetID, operationID, correlationID, string(payload), now)
	return err
}

func (s *Store) ValidateOperationBinding(ctx context.Context, projectRef, targetID, bindingID, capability string) (BindingStatus, error) {
	status, err := s.GetBindingStatus(ctx, projectRef, bindingID)
	if err != nil {
		return BindingStatus{}, ErrOperationBinding
	}
	if status.Binding.ProjectRef != projectRef || status.Binding.TargetID != targetID || status.Binding.BindingID != bindingID || status.Binding.State != "active" {
		return BindingStatus{}, ErrOperationBinding
	}
	if status.Agent == nil || status.Agent.SessionState != "online" {
		return BindingStatus{}, ErrOperationCapability
	}
	for _, observed := range status.Agent.Capabilities {
		if observed.Name == capability && !s.now().UTC().After(observed.ValidUntil) {
			return status, nil
		}
	}
	return BindingStatus{}, ErrOperationCapability
}

func (s *Store) ClaimOperation(ctx context.Context, identity AgentSessionIdentity) (ClaimedOperation, bool, error) {
	if identity.AgentID == "" || identity.ProjectRef == "" || identity.TargetID == "" || identity.BindingID == "" || len(identity.Capabilities) == 0 {
		return ClaimedOperation{}, false, errors.New("complete Agent session identity is required")
	}
	status, err := s.GetBindingStatus(ctx, identity.ProjectRef, identity.BindingID)
	if err != nil {
		return ClaimedOperation{}, false, ErrOperationBinding
	}
	if status.Agent == nil || status.Agent.ID != identity.AgentID || status.Agent.SessionState != "online" || status.Binding.TargetID != identity.TargetID || status.Binding.State != "active" {
		return ClaimedOperation{}, false, ErrOperationBinding
	}
	if err := s.ExpireOperations(ctx); err != nil {
		return ClaimedOperation{}, false, err
	}
	storedCapabilities := make(map[string]struct{}, len(status.Agent.Capabilities))
	for _, capability := range status.Agent.Capabilities {
		if !s.now().UTC().After(capability.ValidUntil) {
			storedCapabilities[capability.Name] = struct{}{}
		}
	}
	capabilities := make([]string, 0, len(identity.Capabilities))
	seen := make(map[string]struct{}, len(identity.Capabilities))
	for _, capability := range identity.Capabilities {
		if _, stored := storedCapabilities[capability]; !stored {
			return ClaimedOperation{}, false, ErrOperationCapability
		}
		if _, duplicate := seen[capability]; duplicate {
			continue
		}
		seen[capability] = struct{}{}
		capabilities = append(capabilities, capability)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ClaimedOperation{}, false, err
	}
	defer tx.Rollback()
	if s.dialect == FleetPostgres {
		if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(19088743, 10)"); err != nil {
			return ClaimedOperation{}, false, err
		}
	}
	placeholders := make([]string, len(capabilities))
	args := []any{identity.ProjectRef, identity.TargetID, identity.BindingID, identity.AgentID}
	for index, capability := range capabilities {
		args = append(args, capability)
		if s.dialect == FleetPostgres {
			placeholders[index] = "$" + strconv.Itoa(index+5)
		} else {
			placeholders[index] = "?"
		}
	}
	query := `SELECT id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,expected_generation,desired_revision,desired_digest,input_schema,fencing_token,idempotency_key,COALESCE(task_id,''),COALESCE(agent_id,''),attempts,deadline_at_ms,typed_input_json,preconditions_json,sensitive,COALESCE(input_ciphertext,x''),COALESCE(input_nonce,x''),created_at_ms,updated_at_ms
FROM operations WHERE project_ref=? AND target_id=? AND binding_id=? AND (state='queued' OR (state='running' AND agent_id=?)) AND capability IN (` + strings.Join(placeholders, ",") + `) ORDER BY CASE WHEN state='running' THEN 0 ELSE 1 END,created_at_ms LIMIT 1`
	if s.dialect == FleetPostgres {
		query = `SELECT id,project_ref,target_id,binding_id,domain,capability,state,protocol_major,protocol_minor,expected_generation,desired_revision,desired_digest,input_schema,fencing_token,idempotency_key,COALESCE(task_id,''),COALESCE(agent_id,''),attempts,deadline_at_ms,typed_input_json,preconditions_json,sensitive,COALESCE(input_ciphertext,''::bytea),COALESCE(input_nonce,''::bytea),created_at_ms,updated_at_ms
FROM operations WHERE project_ref=$1 AND target_id=$2 AND binding_id=$3 AND (state='queued' OR (state='running' AND agent_id=$4)) AND capability IN (` + strings.Join(placeholders, ",") + `) ORDER BY CASE WHEN state='running' THEN 0 ELSE 1 END,created_at_ms FOR UPDATE SKIP LOCKED LIMIT 1`
	}
	var claimed ClaimedOperation
	var typedInput, preconditions, inputCiphertext, inputNonce []byte
	var sensitive bool
	var deadline, created, updated int64
	err = tx.QueryRowContext(ctx, query, args...).Scan(&claimed.ID, &claimed.ProjectRef, &claimed.TargetID, &claimed.BindingID, &claimed.Domain, &claimed.Capability, &claimed.State, &claimed.ProtocolMajor, &claimed.ProtocolMinor, &claimed.ExpectedGeneration, &claimed.DesiredRevision, &claimed.DesiredDigest, &claimed.InputSchema, &claimed.FencingToken, &claimed.IdempotencyKey, &claimed.TaskID, &claimed.AgentID, &claimed.Attempts, &deadline, &typedInput, &preconditions, &sensitive, &inputCiphertext, &inputNonce, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return ClaimedOperation{}, false, nil
	}
	if err != nil {
		return ClaimedOperation{}, false, err
	}
	if sensitive {
		typedInput, err = s.decryptSensitiveInput(inputCiphertext, inputNonce)
		if err != nil {
			return ClaimedOperation{}, false, err
		}
	}
	claimed.DeadlineAt = time.UnixMilli(deadline).UTC()
	if claimed.State == "running" {
		if claimed.TaskID == "" || claimed.AgentID != identity.AgentID {
			return ClaimedOperation{}, false, ErrOperationState
		}
		if err := tx.Commit(); err != nil {
			return ClaimedOperation{}, false, err
		}
		claimed.TypedInput = append(json.RawMessage(nil), typedInput...)
		claimed.Preconditions = append(json.RawMessage(nil), preconditions...)
		claimed.CreatedAt, claimed.UpdatedAt = time.UnixMilli(created).UTC(), time.UnixMilli(updated).UTC()
		return claimed, true, nil
	}
	available, err := s.operationCapacityAvailable(ctx, tx, identity.TargetID)
	if err != nil || !available {
		return ClaimedOperation{}, false, err
	}
	claimed.Attempts++
	claimed.TaskID = claimed.ID + ":" + strconv.Itoa(claimed.Attempts)
	now := s.now().UTC().UnixMilli()
	update := "UPDATE operations SET state='running',attempts=?,task_id=?,agent_id=?,started_at_ms=?,finished_at_ms=NULL,updated_at_ms=? WHERE id=? AND state='queued'"
	if s.dialect == FleetPostgres {
		update = "UPDATE operations SET state='running',attempts=$1,task_id=$2,agent_id=$3,started_at_ms=$4,finished_at_ms=NULL,updated_at_ms=$5 WHERE id=$6 AND state='queued'"
	}
	result, err := tx.ExecContext(ctx, update, claimed.Attempts, claimed.TaskID, identity.AgentID, now, now, claimed.ID)
	if err != nil {
		return ClaimedOperation{}, false, err
	}
	if rows, err := result.RowsAffected(); err != nil || rows != 1 {
		return ClaimedOperation{}, false, ErrOperationState
	}
	attempt := "INSERT INTO operation_attempts(operation_id,attempt,task_id,agent_id,state,started_at_ms) VALUES(?,?,?,?, 'running', ?)"
	if s.dialect == FleetPostgres {
		attempt = "INSERT INTO operation_attempts(operation_id,attempt,task_id,agent_id,state,started_at_ms) VALUES($1,$2,$3,$4,'running',$5)"
	}
	if _, err := tx.ExecContext(ctx, attempt, claimed.ID, claimed.Attempts, claimed.TaskID, identity.AgentID, now); err != nil {
		return ClaimedOperation{}, false, err
	}
	event := "INSERT INTO operation_events(operation_id,event_type,payload_json,created_at_ms) VALUES(?,'operation_running',?,?)"
	if s.dialect == FleetPostgres {
		event = "INSERT INTO operation_events(operation_id,event_type,payload_json,created_at_ms) VALUES($1,'operation_running',$2::jsonb,$3)"
	}
	payload, _ := json.Marshal(map[string]any{"taskId": claimed.TaskID, "agentId": identity.AgentID, "attempt": claimed.Attempts})
	if _, err := tx.ExecContext(ctx, event, claimed.ID, string(payload), now); err != nil {
		return ClaimedOperation{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return ClaimedOperation{}, false, err
	}
	claimed.State = "running"
	claimed.AgentID = identity.AgentID
	claimed.TypedInput = append(json.RawMessage(nil), typedInput...)
	claimed.Preconditions = append(json.RawMessage(nil), preconditions...)
	claimed.CreatedAt, claimed.UpdatedAt = time.UnixMilli(created).UTC(), time.UnixMilli(now).UTC()
	return claimed, true, nil
}

func (s *Store) RecordOperationProgress(ctx context.Context, taskID, agentID string, percent uint32, phase string) error {
	if taskID == "" || agentID == "" || percent > 100 || phase == "" || len(phase) > 128 {
		return errors.New("valid Agent task progress is required")
	}
	var operationID string
	query := "SELECT id FROM operations WHERE task_id=? AND agent_id=? AND state='running'"
	if s.dialect == FleetPostgres {
		query = "SELECT id FROM operations WHERE task_id=$1 AND agent_id=$2 AND state='running'"
	}
	if err := s.db.QueryRowContext(ctx, query, taskID, agentID).Scan(&operationID); errors.Is(err, sql.ErrNoRows) {
		return ErrOperationState
	} else if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"taskId": taskID, "percent": percent, "phase": phase})
	event := "INSERT INTO operation_events(operation_id,event_type,payload_json,created_at_ms) VALUES(?,'task_progress',?,?)"
	if s.dialect == FleetPostgres {
		event = "INSERT INTO operation_events(operation_id,event_type,payload_json,created_at_ms) VALUES($1,'task_progress',$2::jsonb,$3)"
	}
	_, err := s.db.ExecContext(ctx, event, operationID, string(payload), s.now().UTC().UnixMilli())
	return err
}

func (s *Store) CompleteOperation(ctx context.Context, input CompleteOperationInput) error {
	if input.TaskID == "" || input.AgentID == "" || len(input.Evidence) == 0 || !json.Valid(input.Evidence) || input.EvidenceSchema == "" {
		return errors.New("complete typed Agent evidence is required")
	}
	if input.Succeeded && input.ErrorCode != "" || !input.Succeeded && input.ErrorCode == "" {
		return errors.New("Agent result success and error code conflict")
	}
	state := input.TerminalState
	if state == "" {
		state = "succeeded"
		if !input.Succeeded {
			state = "failed"
		}
	}
	if state == "manual_intervention" {
		state = "failed"
	}
	if state != "succeeded" && state != "failed" {
		return errors.New("Agent result terminal state is invalid")
	}
	if input.Succeeded != (state == "succeeded") {
		return errors.New("Agent result terminal state and success conflict")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now().UTC().UnixMilli()
	query := "UPDATE operations SET state=?,evidence_schema=?,evidence_json=?,error_code=?,finished_at_ms=?,updated_at_ms=? WHERE task_id=? AND agent_id=? AND state='running'"
	if s.dialect == FleetPostgres {
		query = "UPDATE operations SET state=$1,evidence_schema=$2,evidence_json=$3::jsonb,error_code=$4,finished_at_ms=$5,updated_at_ms=$6 WHERE task_id=$7 AND agent_id=$8 AND state='running'"
	}
	result, err := tx.ExecContext(ctx, query, state, input.EvidenceSchema, string(input.Evidence), input.ErrorCode, now, now, input.TaskID, input.AgentID)
	if err != nil {
		return err
	}
	if rows, err := result.RowsAffected(); err != nil || rows != 1 {
		return ErrOperationState
	}
	var operationID string
	selectID := "SELECT id FROM operations WHERE task_id=?"
	if s.dialect == FleetPostgres {
		selectID = "SELECT id FROM operations WHERE task_id=$1"
	}
	if err := tx.QueryRowContext(ctx, selectID, input.TaskID).Scan(&operationID); err != nil {
		return err
	}
	attempt := "UPDATE operation_attempts SET state=?,evidence_schema=?,evidence_json=?,error_code=?,finished_at_ms=? WHERE task_id=? AND agent_id=? AND state='running'"
	if s.dialect == FleetPostgres {
		attempt = "UPDATE operation_attempts SET state=$1,evidence_schema=$2,evidence_json=$3::jsonb,error_code=$4,finished_at_ms=$5 WHERE task_id=$6 AND agent_id=$7 AND state='running'"
	}
	if result, err := tx.ExecContext(ctx, attempt, state, input.EvidenceSchema, string(input.Evidence), input.ErrorCode, now, input.TaskID, input.AgentID); err != nil {
		return err
	} else if rows, err := result.RowsAffected(); err != nil || rows != 1 {
		return ErrOperationState
	}
	payload, _ := json.Marshal(map[string]any{"taskId": input.TaskID, "state": state, "errorCode": input.ErrorCode})
	event := "INSERT INTO operation_events(operation_id,event_type,payload_json,created_at_ms) VALUES(?,?,?,?)"
	if s.dialect == FleetPostgres {
		event = "INSERT INTO operation_events(operation_id,event_type,payload_json,created_at_ms) VALUES($1,$2,$3::jsonb,$4)"
	}
	if _, err := tx.ExecContext(ctx, event, operationID, "operation_"+state, string(payload), now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) TouchAgentSession(ctx context.Context, agentID string) error {
	if agentID == "" {
		return errors.New("Agent id is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	policy := s.livenessPolicy()
	now := s.now().UTC()
	leaseExpiresAt := now.Add(policy.LeaseTTL)
	unavailableAt := leaseExpiresAt.Add(policy.StaleGrace)
	query := "UPDATE agents SET state='online',last_seen_at_ms=?,lease_expires_at_ms=?,session_unavailable_at_ms=?,updated_at_ms=? WHERE id=? AND state IN ('online','offline')"
	if s.dialect == FleetPostgres {
		query = "UPDATE agents SET state='online',last_seen_at_ms=$1,lease_expires_at_ms=$2,session_unavailable_at_ms=$3,updated_at_ms=$4 WHERE id=$5 AND state IN ('online','offline')"
	}
	result, err := tx.ExecContext(ctx, query, now.UnixMilli(), leaseExpiresAt.UnixMilli(), unavailableAt.UnixMilli(), now.UnixMilli(), agentID)
	if err != nil {
		return err
	}
	if rows, err := result.RowsAffected(); err != nil || rows != 1 {
		return ErrAgentNotFound
	}
	capabilities := "UPDATE agent_capabilities SET observed_at_ms=?,valid_until_ms=? WHERE agent_id=?"
	if s.dialect == FleetPostgres {
		capabilities = "UPDATE agent_capabilities SET observed_at_ms=$1,valid_until_ms=$2 WHERE agent_id=$3"
	}
	if _, err := tx.ExecContext(ctx, capabilities, now.UnixMilli(), leaseExpiresAt.UnixMilli(), agentID); err != nil {
		return err
	}
	return tx.Commit()
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

func (s *Store) RegisterFunctionArtifact(ctx context.Context, projectRef, digest string, size int64, actor, correlationID string) error {
	if projectRef == "" || digest == "" || size < 1 || actor == "" || correlationID == "" {
		return errors.New("complete function artifact metadata is required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.lockArtifactQuotaTx(ctx, tx, projectRef); err != nil {
		return err
	}
	existingQuery := `SELECT size_bytes FROM function_artifacts WHERE project_ref=? AND digest=?`
	if s.dialect == FleetPostgres {
		existingQuery = `SELECT size_bytes FROM function_artifacts WHERE project_ref=$1 AND digest=$2`
	}
	var existingSize int64
	if err := tx.QueryRowContext(ctx, existingQuery, projectRef, digest).Scan(&existingSize); err == nil {
		if existingSize != size {
			return errors.New("immutable function artifact metadata conflict")
		}
		return tx.Commit()
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err := s.enforceArtifactQuotaTx(ctx, tx, projectRef, size); err != nil {
		return err
	}
	query := `INSERT INTO function_artifacts(project_ref,digest,size_bytes,created_by,correlation_id,created_at_ms)
VALUES(?,?,?,?,?,?) ON CONFLICT(project_ref,digest) DO NOTHING`
	if s.dialect == FleetPostgres {
		query = `INSERT INTO function_artifacts(project_ref,digest,size_bytes,created_by,correlation_id,created_at_ms)
VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(project_ref,digest) DO NOTHING`
	}
	if _, err := tx.ExecContext(ctx, query, projectRef, digest, size, actor, correlationID, s.now().UTC().UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) GetFunctionArtifact(ctx context.Context, projectRef, digest string) (int64, bool, error) {
	query := "SELECT size_bytes FROM function_artifacts WHERE project_ref=? AND digest=?"
	if s.dialect == FleetPostgres {
		query = "SELECT size_bytes FROM function_artifacts WHERE project_ref=$1 AND digest=$2"
	}
	var size int64
	if err := s.db.QueryRowContext(ctx, query, projectRef, digest).Scan(&size); errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	} else if err != nil {
		return 0, false, err
	}
	return size, true, nil
}
