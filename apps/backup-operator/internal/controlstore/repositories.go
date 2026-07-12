package controlstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

var ErrStanzaIdentityConflict = errors.New("repository stanza is already bound to a different PostgreSQL history")

type RepositoryRecord struct {
	ID                   string
	Fingerprint          string
	Type                 string
	Endpoint             string
	EncryptedCredentials []byte
	KeyID                string
}

func (s *Store) RegisterRepository(ctx context.Context, repository RepositoryRecord) error {
	now := s.now().UnixMilli()
	query := `INSERT INTO repositories(id,fingerprint,type,endpoint,encrypted_credentials,key_id,created_at_ms,updated_at_ms)
VALUES(?,?,?,?,?,?,?,?)`
	if s.dialect == Postgres {
		query = `INSERT INTO repositories(id,fingerprint,type,endpoint,encrypted_credentials,key_id,created_at_ms,updated_at_ms)
VALUES($1,$2,$3,$4,$5,$6,$7,$8)`
	}
	_, err := s.db.ExecContext(ctx, query, repository.ID, repository.Fingerprint, repository.Type, repository.Endpoint, repository.EncryptedCredentials, repository.KeyID, now, now)
	return err
}

type StanzaBinding struct {
	RepositoryID      string
	Stanza            string
	SystemIdentifier  string
	PostgresMajor     int
	DatabaseHistoryID string
}

func (s *Store) BindStanza(ctx context.Context, binding StanzaBinding) error {
	if binding.RepositoryID == "" || binding.Stanza == "" || binding.SystemIdentifier == "" || binding.PostgresMajor < 1 || binding.DatabaseHistoryID == "" {
		return errors.New("complete stanza identity is required")
	}
	var systemID, history string
	var major int
	query := "SELECT system_identifier, postgres_major, database_history_id FROM stanza_bindings WHERE repository_id=? AND stanza=?"
	if s.dialect == Postgres {
		query = "SELECT system_identifier, postgres_major, database_history_id FROM stanza_bindings WHERE repository_id=$1 AND stanza=$2"
	}
	err := s.db.QueryRowContext(ctx, query, binding.RepositoryID, binding.Stanza).Scan(&systemID, &major, &history)
	if err == nil {
		if systemID == binding.SystemIdentifier && major == binding.PostgresMajor && history == binding.DatabaseHistoryID {
			return nil
		}
		return ErrStanzaIdentityConflict
	}
	if err != sql.ErrNoRows {
		return err
	}
	insert := "INSERT INTO stanza_bindings(repository_id,stanza,system_identifier,postgres_major,database_history_id,created_at_ms) VALUES(?,?,?,?,?,?)"
	if s.dialect == Postgres {
		insert = "INSERT INTO stanza_bindings(repository_id,stanza,system_identifier,postgres_major,database_history_id,created_at_ms) VALUES($1,$2,$3,$4,$5,$6)"
	}
	_, err = s.db.ExecContext(ctx, insert, binding.RepositoryID, binding.Stanza, binding.SystemIdentifier, binding.PostgresMajor, binding.DatabaseHistoryID, s.now().UnixMilli())
	return err
}

func (s *Store) RotateRepositoryCredentials(ctx context.Context, repositoryID, keyID string, encrypted []byte, expectedGeneration int64) (int64, error) {
	query := `UPDATE repositories SET encrypted_credentials=?, key_id=?, credential_generation=credential_generation+1, updated_at_ms=?
WHERE id=? AND credential_generation=? RETURNING credential_generation`
	args := []any{encrypted, keyID, s.now().UnixMilli(), repositoryID, expectedGeneration}
	if s.dialect == Postgres {
		query = `UPDATE repositories SET encrypted_credentials=$1, key_id=$2, credential_generation=credential_generation+1, updated_at_ms=$3
WHERE id=$4 AND credential_generation=$5 RETURNING credential_generation`
	}
	var generation int64
	if err := s.db.QueryRowContext(ctx, query, args...).Scan(&generation); err != nil {
		if err == sql.ErrNoRows {
			return 0, fmt.Errorf("repository credential generation changed")
		}
		return 0, err
	}
	return generation, nil
}
