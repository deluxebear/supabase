package recoverydomain

import (
	"errors"
	"fmt"
	"strings"
)

var (
	ErrMissingIdentity      = errors.New("recovery-domain identity is incomplete")
	ErrSameSystemIdentifier = errors.New("control store uses the managed PostgreSQL system identifier")
	ErrSharedDataDomain     = errors.New("control store shares the managed data domain")
)

// Identity contains the two independently observed facts needed to reject a
// circular control-store deployment. SystemIdentifier is PostgreSQL's cluster
// identifier. DataDomain identifies the lifecycle/storage boundary, such as a
// Docker volume ID, Kubernetes PVC UID, or canonical bare-metal filesystem ID.
type Identity struct {
	SystemIdentifier string
	DataDomain       string
}

// ValidateIndependent rejects a control store that can be stopped or rolled
// back with the PostgreSQL cluster it manages.
func ValidateIndependent(target, control Identity) error {
	target.SystemIdentifier = strings.TrimSpace(target.SystemIdentifier)
	control.SystemIdentifier = strings.TrimSpace(control.SystemIdentifier)
	target.DataDomain = strings.TrimSpace(target.DataDomain)
	control.DataDomain = strings.TrimSpace(control.DataDomain)

	if target.SystemIdentifier == "" || control.SystemIdentifier == "" ||
		target.DataDomain == "" || control.DataDomain == "" {
		return ErrMissingIdentity
	}
	if target.SystemIdentifier == control.SystemIdentifier {
		return fmt.Errorf("%w: %s", ErrSameSystemIdentifier, target.SystemIdentifier)
	}
	if target.DataDomain == control.DataDomain {
		return fmt.Errorf("%w: %s", ErrSharedDataDomain, target.DataDomain)
	}
	return nil
}
