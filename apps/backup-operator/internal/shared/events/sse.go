// Package events contains bounded, cursor-based event replay shared by control
// services. Domain stores retain ownership of event payloads and retention.
package events

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

type Snapshot struct {
	Cursor int64
	Data   any
}

type CursorReader interface {
	EventReader
	CursorWindow(context.Context, string) (earliest, latest int64, err error)
	CurrentSnapshot(context.Context, string) (Snapshot, error)
}

func ReplaySSEWithSnapshot(ctx context.Context, writer io.Writer, reader CursorReader, operationID string, cursor int64, limit int) (int64, bool, error) {
	if reader == nil || writer == nil || operationID == "" || cursor < 0 || limit < 1 || limit > 1000 {
		return cursor, false, errors.New("valid SSE reader, operation, cursor, and bounded limit are required")
	}
	earliest, _, err := reader.CursorWindow(ctx, operationID)
	if err != nil {
		return cursor, false, err
	}
	if cursor > 0 && earliest > 0 && cursor < earliest-1 {
		snapshot, err := reader.CurrentSnapshot(ctx, operationID)
		if err != nil {
			return cursor, true, err
		}
		payload, err := json.Marshal(snapshot.Data)
		if err != nil {
			return cursor, true, err
		}
		if snapshot.Cursor < earliest-1 {
			return cursor, true, errors.New("snapshot cursor predates retained event history")
		}
		if _, err := fmt.Fprintf(writer, "id: %d\nevent: snapshot\ndata: %s\n\n", snapshot.Cursor, payload); err != nil {
			return cursor, true, err
		}
		return snapshot.Cursor, true, nil
	}
	last, err := ReplaySSE(ctx, writer, reader, operationID, cursor, limit)
	return last, false, err
}

func ReplaySSE(ctx context.Context, writer io.Writer, reader EventReader, operationID string, cursor int64, limit int) (int64, error) {
	if reader == nil || writer == nil || operationID == "" || cursor < 0 || limit < 1 || limit > 1000 {
		return cursor, errors.New("valid SSE reader, operation, cursor, and bounded limit are required")
	}
	events, err := reader.ReadAfter(ctx, operationID, cursor, limit)
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
