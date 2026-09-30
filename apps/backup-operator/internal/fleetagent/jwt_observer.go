package fleetagent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetjwt"
)

func (c Client) observeJWT(ctx context.Context) []byte {
	if c.JWTObserverURL == "" && c.JWTObserver == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if c.JWTObserver != nil {
		raw, err := c.JWTObserver(ctx)
		if err != nil || len(raw) > 32768 {
			return nil
		}
		var report fleetjwt.Observation
		if json.Unmarshal(raw, &report) != nil || report.Validate(c.Executor.ProjectRef, c.BindingID, time.Now()) != nil {
			return nil
		}
		return raw
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.JWTObserverURL, nil)
	if err != nil {
		return nil
	}
	response, err := (&http.Client{Timeout: 8 * time.Second}).Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 32769))
	if err != nil || len(raw) > 32768 {
		return nil
	}
	var report fleetjwt.Observation
	if json.Unmarshal(raw, &report) != nil || report.Validate(c.Executor.ProjectRef, c.BindingID, time.Now()) != nil {
		return nil
	}
	return raw
}
