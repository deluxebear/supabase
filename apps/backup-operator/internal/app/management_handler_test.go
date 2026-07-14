package app

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

type managementEvidenceRuntime struct{ managementRuntimeFake }

func (f *managementEvidenceRuntime) BackupEvidence(_ context.Context, kind, repository, key string) (controlstore.BackupManifestRecord, error) {
	f.calls = append(f.calls, "backup-evidence:"+kind+":"+repository+":"+key)
	return controlstore.BackupManifestRecord{
		ProviderJobID: "20260714-023549F",
		BackupLabel:   "20260714-023549F",
		CompletedAt:   time.Date(2026, 7, 14, 2, 35, 52, 0, time.UTC),
		ManifestJSON:  "{}",
	}, nil
}

type managementRuntimeFake struct{ calls []string }

func (f *managementRuntimeFake) Backup(_ context.Context, kind, repository, key string) error {
	f.calls = append(f.calls, "backup:"+kind+":"+repository+":"+key)
	return nil
}
func (f *managementRuntimeFake) EnablePITR(_ context.Context, repository string, generation int64, key string) error {
	f.calls = append(f.calls, "enable:"+repository+":"+strconv.FormatInt(generation, 10)+":"+key)
	return nil
}
func (f *managementRuntimeFake) DisablePITR(_ context.Context, _ int64, key string) error {
	f.calls = append(f.calls, "disable:"+key)
	return nil
}
func (f *managementRuntimeFake) RepositoryCheck(context.Context) error {
	f.calls = append(f.calls, "check")
	return nil
}
func (f *managementRuntimeFake) Expire(_ context.Context, key string) error {
	f.calls = append(f.calls, "expire:"+key)
	return nil
}
func (f *managementRuntimeFake) RestoreDrill(_ context.Context, key string) error {
	f.calls = append(f.calls, "drill:"+key)
	return nil
}

func TestManagementTaskHandlerExecutesAllowlistedTypedOperations(t *testing.T) {
	runtime := &managementRuntimeFake{}
	handler := ManagementTaskHandler{Provider: CapabilitySinglePrimary, Runtime: runtime}
	tasks := []controlstore.OutboxTask{
		{Capability: CapabilitySinglePrimary + ".backup.full", IdempotencyKey: "backup-key", Payload: []byte(`{"repositoryId":"repo"}`)},
		{Capability: CapabilitySinglePrimary + ".pitr.enable", IdempotencyKey: "enable-key", Payload: []byte(`{"repositoryId":"repo","generation":"7"}`)},
		{Capability: CapabilitySinglePrimary + ".maintenance.repository-check", IdempotencyKey: "check-key", Payload: []byte(`{"kind":"repository-check"}`)},
	}
	for _, task := range tasks {
		if err := handler.Execute(context.Background(), task); err != nil {
			t.Fatal(err)
		}
	}
	if len(runtime.calls) != 3 || runtime.calls[0] != "backup:full:repo:backup-key" || runtime.calls[1] != "enable:repo:7:enable-key" || runtime.calls[2] != "check" {
		t.Fatalf("calls = %#v", runtime.calls)
	}
}

func TestManagementTaskHandlerFailsClosed(t *testing.T) {
	handler := ManagementTaskHandler{Provider: CapabilitySinglePrimary, Runtime: &managementRuntimeFake{}}
	for _, task := range []controlstore.OutboxTask{
		{Capability: "other.backup.full", Payload: []byte(`{}`)},
		{Capability: CapabilitySinglePrimary + ".backup.shell", Payload: []byte(`{}`)},
		{Capability: CapabilitySinglePrimary + ".backup.full", Payload: []byte(`{"repositoryId":"repo","binary":"/bin/sh"}`)},
		{Capability: CapabilitySinglePrimary + ".backup.full", Payload: []byte(`{"repositoryId":"repo","backupFrom":"standby","designatedStandby":"db-1"}`)},
	} {
		if err := handler.Execute(context.Background(), task); err == nil {
			t.Fatalf("accepted %#v", task)
		}
	}
}

func TestManagementTaskHandlerReturnsTypedBackupManifestEvidence(t *testing.T) {
	runtime := &managementEvidenceRuntime{}
	handler := ManagementTaskHandler{Provider: CapabilitySinglePrimary, Runtime: runtime}
	task := controlstore.OutboxTask{
		Capability:     CapabilitySinglePrimary + ".backup.full",
		IdempotencyKey: "backup-key",
		Payload:        []byte(`{"policyId":"policy-a","repositoryId":"repo-a","backupType":"full"}`),
	}
	evidence, err := handler.ExecuteWithEvidence(context.Background(), task)
	if err != nil {
		t.Fatal(err)
	}
	var manifest controlstore.BackupManifestRecord
	if err := json.Unmarshal(evidence, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.PolicyID != "policy-a" || manifest.RepositoryID != "repo-a" || manifest.BackupType != "full" || manifest.BackupLabel != "20260714-023549F" {
		t.Fatalf("manifest = %#v", manifest)
	}
}
