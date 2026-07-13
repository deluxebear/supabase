package drill

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCommandValidatorRequiresSystemTimelineReadOnlyAndTargetDataEvidence(t *testing.T) {
	target := drillTarget()
	binary := filepath.Join(t.TempDir(), "validator")
	payload := fmt.Sprintf(`{"databaseSystemId":"42","databaseHistoryId":"7","timeline":1,"readOnly":true,"targetDataVerified":true,"observedTargetTime":%q,"startupMode":"isolated","networkExposure":"disabled"}`, target.TargetTime.Add(-time.Second).Format(time.RFC3339Nano))
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s' '"+payload+"'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	checks, err := (CommandValidator{Binary: binary, AllowedBinaries: []string{binary}, Timeout: time.Minute}).ValidateIsolated(context.Background(), "/isolated/pgdata", target)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"databaseSystemId", "databaseHistoryId", "timeline", "readOnly", "targetData", "startupMode", "networkExposure"} {
		if checks[key] == "" {
			t.Fatalf("missing check %s: %#v", key, checks)
		}
	}
}

func TestCommandValidatorRejectsLineageMismatch(t *testing.T) {
	target := drillTarget()
	binary := filepath.Join(t.TempDir(), "validator")
	payload := fmt.Sprintf(`{"databaseSystemId":"99","databaseHistoryId":"7","timeline":1,"readOnly":true,"targetDataVerified":true,"observedTargetTime":%q,"startupMode":"isolated","networkExposure":"disabled"}`, target.TargetTime.Format(time.RFC3339Nano))
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nprintf '%s' '"+payload+"'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := (CommandValidator{Binary: binary, AllowedBinaries: []string{binary}, Timeout: time.Minute}).ValidateIsolated(context.Background(), "/isolated/pgdata", target); err == nil {
		t.Fatal("mismatched database system identifier was accepted")
	}
}
