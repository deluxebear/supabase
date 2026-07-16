package fleetcontrol

import (
	"context"
	"database/sql"
	"fmt"
)

type RetentionResult struct {
	OperationEventsArchived int64
	AuditEventsArchived     int64
}

func (s *Store) EnforceRetention(ctx context.Context) (RetentionResult, error) {
	if err := s.capacity.Validate(); err != nil {
		return RetentionResult{}, err
	}
	now := s.now().UTC()
	eventIDs, err := s.retainedEventIDs(ctx, now.Add(-s.capacity.TerminalEventRetention).UnixMilli())
	if err != nil {
		return RetentionResult{}, err
	}
	auditIDs, err := s.retainedAuditIDs(ctx, now.Add(-s.capacity.AuditRetention).UnixMilli())
	if err != nil {
		return RetentionResult{}, err
	}
	result := RetentionResult{}
	if result.OperationEventsArchived, err = s.archiveRows(ctx, "operation_events", "operation_event_archive", eventIDs, now.UnixMilli()); err != nil {
		return result, err
	}
	if result.AuditEventsArchived, err = s.archiveRows(ctx, "audit_events", "audit_event_archive", auditIDs, now.UnixMilli()); err != nil {
		return result, err
	}
	return result, nil
}

func (s *Store) retainedEventIDs(ctx context.Context, terminalBefore int64) ([]int64, error) {
	query := `SELECT id FROM (
SELECT e.id,e.created_at_ms,o.state,ROW_NUMBER() OVER(PARTITION BY e.operation_id ORDER BY e.id DESC) AS position
FROM operation_events e JOIN operations o ON o.id=e.operation_id
) retained WHERE position>? OR (state IN ('succeeded','failed','cancelled','timed_out') AND created_at_ms<?)
ORDER BY id LIMIT ?`
	if s.dialect == FleetPostgres {
		query = `SELECT id FROM (
SELECT e.id,e.created_at_ms,o.state,ROW_NUMBER() OVER(PARTITION BY e.operation_id ORDER BY e.id DESC) AS position
FROM operation_events e JOIN operations o ON o.id=e.operation_id
) retained WHERE position>$1 OR (state IN ('succeeded','failed','cancelled','timed_out') AND created_at_ms<$2)
ORDER BY id LIMIT $3`
	}
	return scanIDs(ctx, s.db, query, s.capacity.MaxEventsPerOperation, terminalBefore, s.capacity.RetentionBatchSize)
}

func (s *Store) retainedAuditIDs(ctx context.Context, before int64) ([]int64, error) {
	query := "SELECT id FROM audit_events WHERE created_at_ms<? ORDER BY id LIMIT ?"
	if s.dialect == FleetPostgres {
		query = "SELECT id FROM audit_events WHERE created_at_ms<$1 ORDER BY id LIMIT $2"
	}
	return scanIDs(ctx, s.db, query, before, s.capacity.RetentionBatchSize)
}

func scanIDs(ctx context.Context, db *sql.DB, query string, args ...any) ([]int64, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) archiveRows(ctx context.Context, source, archive string, ids []int64, archivedAt int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	for _, id := range ids {
		var insert, remove string
		switch source {
		case "operation_events":
			insert = `INSERT INTO operation_event_archive(id,operation_id,event_type,payload_json,created_at_ms,archived_at_ms) SELECT id,operation_id,event_type,payload_json,created_at_ms,? FROM operation_events WHERE id=? ON CONFLICT(id) DO NOTHING`
		case "audit_events":
			insert = `INSERT INTO audit_event_archive(id,actor,project_ref,action,target_id,operation_id,correlation_id,payload_json,created_at_ms,archived_at_ms) SELECT id,actor,project_ref,action,target_id,operation_id,correlation_id,payload_json,created_at_ms,? FROM audit_events WHERE id=? ON CONFLICT(id) DO NOTHING`
		default:
			return 0, fmt.Errorf("unsupported Fleet retention source %q", source)
		}
		remove = "DELETE FROM " + source + " WHERE id=?"
		if s.dialect == FleetPostgres {
			insert = replaceRetentionPlaceholders(insert)
			remove = "DELETE FROM " + source + " WHERE id=$1"
		}
		if _, err := tx.ExecContext(ctx, insert, archivedAt, id); err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, remove, id); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return int64(len(ids)), nil
}

func replaceRetentionPlaceholders(value string) string {
	replaced := false
	result := make([]byte, 0, len(value)+2)
	index := 1
	for i := 0; i < len(value); i++ {
		if value[i] == '?' {
			result = append(result, '$', byte('0'+index))
			index++
			replaced = true
		} else {
			result = append(result, value[i])
		}
	}
	if !replaced {
		return value
	}
	return string(result)
}
