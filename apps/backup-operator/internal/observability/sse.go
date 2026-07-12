package observability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

type Event struct {
	Cursor int64
	Type   string
	Data   any
}

type EventReader interface {
	ReadAfter(context.Context, string, int64, int) ([]Event, error)
}

// ReplaySSE writes a bounded, resumable SSE page. Callers pass Last-Event-ID
// as cursor and reconnect after the page; no unbounded goroutine is retained.
func ReplaySSE(ctx context.Context, writer io.Writer, reader EventReader, jobID string, cursor int64, limit int) (int64, error) {
	if reader == nil || writer == nil || jobID == "" || cursor < 0 || limit < 1 || limit > 1000 {
		return cursor, errors.New("valid SSE reader, job, cursor, and bounded limit are required")
	}
	events, err := reader.ReadAfter(ctx, jobID, cursor, limit)
	if err != nil {
		return cursor, err
	}
	last := cursor
	for _, event := range events {
		if event.Cursor <= last || event.Type == "" {
			return last, errors.New("event cursor must increase monotonically")
		}
		payload, err := json.Marshal(event.Data)
		if err != nil {
			return last, err
		}
		if _, err := fmt.Fprintf(writer, "id: %d\nevent: %s\ndata: %s\n\n", event.Cursor, event.Type, payload); err != nil {
			return last, err
		}
		last = event.Cursor
	}
	return last, nil
}
