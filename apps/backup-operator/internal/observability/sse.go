package observability

import (
	"context"
	"io"

	sharedevents "github.com/supabase/supabase/apps/backup-operator/internal/shared/events"
)

type Event = sharedevents.Event
type EventReader = sharedevents.EventReader
type Snapshot = sharedevents.Snapshot
type CursorReader = sharedevents.CursorReader

func ReplaySSEWithSnapshot(ctx context.Context, writer io.Writer, reader CursorReader, jobID string, cursor int64, limit int) (int64, bool, error) {
	return sharedevents.ReplaySSEWithSnapshot(ctx, writer, reader, jobID, cursor, limit)
}

func ReplaySSE(ctx context.Context, writer io.Writer, reader EventReader, jobID string, cursor int64, limit int) (int64, error) {
	return sharedevents.ReplaySSE(ctx, writer, reader, jobID, cursor, limit)
}
