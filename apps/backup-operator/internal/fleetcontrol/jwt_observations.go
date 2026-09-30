package fleetcontrol

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetjwt"
)

func (s *Store) RecordAgentJWTObservation(ctx context.Context, agent, project, binding string, raw []byte) error {
	var report fleetjwt.Observation
	if len(raw) > 32768 || json.Unmarshal(raw, &report) != nil || report.Validate(project, binding, s.now()) != nil {
		return errors.New("JWT observation is invalid")
	}
	query := `INSERT INTO agent_jwt_observations(agent_id,observation_json,observed_at_ms) VALUES(?,?,?)
 ON CONFLICT(agent_id) DO UPDATE SET observation_json=excluded.observation_json,observed_at_ms=excluded.observed_at_ms WHERE excluded.observed_at_ms > agent_jwt_observations.observed_at_ms`
	if s.dialect == FleetPostgres {
		query = `INSERT INTO agent_jwt_observations(agent_id,observation_json,observed_at_ms) VALUES($1,$2,$3)
 ON CONFLICT(agent_id) DO UPDATE SET observation_json=excluded.observation_json,observed_at_ms=excluded.observed_at_ms WHERE excluded.observed_at_ms > agent_jwt_observations.observed_at_ms`
	}
	_, err := s.db.ExecContext(ctx, query, agent, string(raw), report.ObservedAt.UnixMilli())
	return err
}

func (s *Store) agentJWTObservation(ctx context.Context, agent string) (json.RawMessage, error) {
	query := "SELECT observation_json FROM agent_jwt_observations WHERE agent_id=?"
	if s.dialect == FleetPostgres {
		query = "SELECT observation_json FROM agent_jwt_observations WHERE agent_id=$1"
	}
	var raw string
	err := s.db.QueryRowContext(ctx, query, agent).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return json.RawMessage(raw), err
}
