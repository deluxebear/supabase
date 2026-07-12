package recoverydomain

import (
	"errors"
	"testing"
)

func TestValidateIndependent(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		target  Identity
		control Identity
		wantErr error
	}{
		{
			name:    "independent stores",
			target:  Identity{SystemIdentifier: "target-system", DataDomain: "target-volume"},
			control: Identity{SystemIdentifier: "control-system", DataDomain: "control-volume"},
		},
		{
			name:    "same postgres cluster",
			target:  Identity{SystemIdentifier: "same-system", DataDomain: "target-volume"},
			control: Identity{SystemIdentifier: "same-system", DataDomain: "control-volume"},
			wantErr: ErrSameSystemIdentifier,
		},
		{
			name:    "shared lifecycle volume",
			target:  Identity{SystemIdentifier: "target-system", DataDomain: "shared-volume"},
			control: Identity{SystemIdentifier: "control-system", DataDomain: "shared-volume"},
			wantErr: ErrSharedDataDomain,
		},
		{
			name:    "missing observed identity fails closed",
			target:  Identity{SystemIdentifier: "target-system"},
			control: Identity{SystemIdentifier: "control-system", DataDomain: "control-volume"},
			wantErr: ErrMissingIdentity,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := ValidateIndependent(tt.target, tt.control)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("ValidateIndependent() error = %v, want %v", err, tt.wantErr)
			}
		})
	}
}
