package api

import (
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
)

func TestDrillStatusExplainsWhyAWindowIsNotVerified(t *testing.T) {
	from := time.Date(2026, 10, 12, 6, 41, 52, 0, time.UTC)
	inferred := recoverability.Window{Confidence: recoverability.Inferred, From: from}
	drillAt := func(target time.Time, passed bool) *recoverability.DrillRecord {
		return &recoverability.DrillRecord{TargetTime: target, Passed: passed}
	}
	for name, test := range map[string]struct {
		window recoverability.Window
		drill  *recoverability.DrillRecord
		want   string
	}{
		"verified":      {recoverability.Window{Confidence: recoverability.DrillVerified, From: from}, drillAt(from.Add(time.Minute), true), "verified"},
		"no drill":      {inferred, nil, "none"},
		"failed drill":  {inferred, drillAt(from.Add(time.Minute), false), "failed"},
		"older backup":  {inferred, drillAt(from.Add(-8*time.Minute), true), "older-than-latest-backup"},
		"other lineage": {inferred, drillAt(from.Add(time.Minute), true), "mismatch"},
	} {
		if got := drillStatus(test.window, test.drill); got != test.want {
			t.Errorf("%s: drillStatus = %q, want %q", name, got, test.want)
		}
	}
}
