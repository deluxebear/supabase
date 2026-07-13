package drill

import (
	"context"
	"errors"

	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
)

type ObservationSource interface {
	ObserveRecoverability(context.Context, string) (recoverability.Observation, error)
}

type Projection struct {
	Observations ObservationSource
	Results      Store
}

func (p Projection) ObserveRecoverability(ctx context.Context, clusterID string) (recoverability.Window, *recoverability.DrillRecord, error) {
	if p.Observations == nil || p.Results == nil {
		return recoverability.Window{}, nil, errors.New("recoverability projection sources are required")
	}
	observation, err := p.Observations.ObserveRecoverability(ctx, clusterID)
	if err != nil {
		return recoverability.Window{}, nil, err
	}
	result, err := p.Results.Latest(ctx, clusterID)
	if err == nil {
		observation.Drill = &result.Record
	} else if !errors.Is(err, ErrNotFound) {
		return recoverability.Window{}, nil, err
	}
	window := recoverability.Evaluate(observation)
	return window, observation.Drill, nil
}
