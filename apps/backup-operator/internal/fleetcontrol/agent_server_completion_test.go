package fleetcontrol

import (
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
)

func TestConfigurationCompletionDistinguishesObservationFromApply(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		evidence  fleetproviders.Evidence
		succeeded bool
		errorCode string
	}{
		{
			name:      "observation-only drift evidence succeeds without an apply claim",
			evidence:  fleetproviders.Evidence{ObservationOnly: true, DriftState: "drifted"},
			succeeded: true,
		},
		{
			name:      "applied direct-managed evidence succeeds",
			evidence:  fleetproviders.Evidence{Applied: true, DriftState: "in-sync"},
			succeeded: true,
		},
		{
			name:      "unapplied mutation is rejected",
			evidence:  fleetproviders.Evidence{DriftState: "drifted"},
			errorCode: "configuration_not_applied",
		},
		{
			name:      "ownership conflicts remain terminal failures",
			evidence:  fleetproviders.Evidence{ObservationOnly: true, DriftState: "ownership-conflict"},
			errorCode: "ownership_conflict",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			succeeded, errorCode := configurationCompletion(test.evidence)
			if succeeded != test.succeeded || errorCode != test.errorCode {
				t.Fatalf("completion = (%v, %q), want (%v, %q)", succeeded, errorCode, test.succeeded, test.errorCode)
			}
		})
	}
}
