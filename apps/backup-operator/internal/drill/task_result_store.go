package drill

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

type TaskEvidenceSource interface {
	LatestSuccessfulTaskEvidence(context.Context, string, string) ([]byte, error)
}

// TaskResultStore projects Agent typed evidence from the durable control store.
// Save is intentionally unsupported because the only writer is task result
// reconciliation, which preserves task idempotency and fencing semantics.
type TaskResultStore struct {
	Source     TaskEvidenceSource
	Capability string
}

func (s TaskResultStore) Save(context.Context, Result) error {
	return errors.New("task result drill store is read-only")
}

func (s TaskResultStore) Latest(ctx context.Context, clusterID string) (Result, error) {
	if s.Source == nil || s.Capability == "" || clusterID == "" {
		return Result{}, errors.New("task evidence source, capability, and cluster are required")
	}
	evidence, err := s.Source.LatestSuccessfulTaskEvidence(ctx, clusterID, s.Capability)
	if errors.Is(err, controlstore.ErrTaskEvidenceNotFound) {
		return Result{}, ErrNotFound
	}
	if err != nil {
		return Result{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(evidence))
	decoder.DisallowUnknownFields()
	var result Result
	if err := decoder.Decode(&result); err != nil {
		return Result{}, errors.New("stored restore drill evidence is invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) || result.ClusterID != clusterID || result.Record.ID == "" {
		return Result{}, errors.New("stored restore drill evidence has invalid identity")
	}
	return result, nil
}
