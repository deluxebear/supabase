package controlstore

import (
	"context"
	"encoding/json"
	"errors"
	"io"
)

type ExportEvent struct {
	Stream      string          `json:"stream"`
	Cursor      int64           `json:"cursor"`
	Subject     string          `json:"subject"`
	Type        string          `json:"type"`
	Payload     json.RawMessage `json:"payload"`
	CreatedAtMS int64           `json:"createdAtMs"`
}

func (s *Store) ExportEvents(ctx context.Context, writer io.Writer, afterCursor int64, limit int) (int64, error) {
	if writer == nil || afterCursor < 0 || limit < 1 || limit > 10_000 {
		return afterCursor, errors.New("writer, non-negative cursor, and bounded export limit are required")
	}
	query := `SELECT id, job_id, event_type, payload_json, created_at_ms FROM job_events WHERE id>? ORDER BY id LIMIT ?`
	if s.dialect == Postgres {
		query = `SELECT id, job_id, event_type, payload_json::text, created_at_ms FROM job_events WHERE id>$1 ORDER BY id LIMIT $2`
	}
	rows, err := s.db.QueryContext(ctx, query, afterCursor, limit)
	if err != nil {
		return afterCursor, err
	}
	defer rows.Close()
	encoder := json.NewEncoder(writer)
	last := afterCursor
	for rows.Next() {
		var event ExportEvent
		var payload string
		if err := rows.Scan(&event.Cursor, &event.Subject, &event.Type, &payload, &event.CreatedAtMS); err != nil {
			return last, err
		}
		event.Stream = "job"
		event.Payload = json.RawMessage(payload)
		if err := encoder.Encode(event); err != nil {
			return last, err
		}
		last = event.Cursor
	}
	return last, rows.Err()
}
