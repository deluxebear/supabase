package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validRegistration() map[string]string {
	return map[string]string{
		"projectId": "project-d", "targetId": "project-d", "nodeId": "project-d-db", "agentId": "backup-agent-project-d",
		"certificateFingerprint": "sha256:abc", "systemIdentifier": "7690825307688509473", "dataDomain": "supabase-managed-d_managed-db-data",
		"stanza": "project-d", "pgbackrestBinary": "/usr/lib/pgbackrest/bin/pgbackrest.real", "pgbackrestConfig": "/etc/pgbackrest/pgbackrest.conf",
		"repositoryId": "fleet-backup-project-d", "repositoryType": "s3", "repositoryEndpoint": "backup-repository:9000",
		"repositoryLocation": "s3://fleet-backup-project-d/pgbackrest", "repositoryFingerprint": "s3:backup-repository/fleet-backup-project-d", "repositoryRevision": "sha256:config",
	}
}

func writeRegistration(t *testing.T, dir, name string, value any, mode os.FileMode) {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), payload, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(dir, name), mode); err != nil {
		t.Fatal(err)
	}
}

func TestLoadClusterRegistrations(t *testing.T) {
	dir := t.TempDir()
	writeRegistration(t, dir, "project-d.json", validRegistration(), 0o600)
	other := validRegistration()
	for _, key := range []string{"projectId", "targetId", "stanza"} {
		other[key] = "project-e"
	}
	other["nodeId"], other["agentId"] = "project-e-db", "backup-agent-project-e"
	writeRegistration(t, dir, "project-e.json", other, 0o600)
	if err := os.WriteFile(filepath.Join(dir, "README"), []byte("ignored"), 0o644); err != nil {
		t.Fatal(err)
	}
	registrations, err := loadClusterRegistrations(dir)
	if err != nil || len(registrations) != 2 || registrations[0].TargetID != "project-d" {
		t.Fatalf("registrations = %+v, err = %v", registrations, err)
	}
	if got := registrations[0].archiveCommand(); got != "/usr/lib/pgbackrest/bin/pgbackrest.real --config=/etc/pgbackrest/pgbackrest.conf --stanza=project-d archive-push %p" {
		t.Fatalf("archive command = %q", got)
	}
	capabilities := strings.Join(registrations[0].capabilities(), ",")
	for _, want := range []string{".backup.full", ".pitr.enable", ".maintenance.observe", ".restore.execute"} {
		if !strings.Contains(capabilities, want) {
			t.Fatalf("capabilities %s lack %s", capabilities, want)
		}
	}
}

func TestLoadClusterRegistrationsRejectsUnsafeInput(t *testing.T) {
	cases := map[string]func(dir string){
		"group-readable": func(dir string) { writeRegistration(t, dir, "a.json", validRegistration(), 0o640) },
		"unknown field": func(dir string) {
			value := validRegistration()
			value["dockerSocket"] = "/var/run/docker.sock"
			writeRegistration(t, dir, "a.json", value, 0o600)
		},
		"relative binary": func(dir string) {
			value := validRegistration()
			value["pgbackrestBinary"] = "pgbackrest"
			writeRegistration(t, dir, "a.json", value, 0o600)
		},
		"duplicate node": func(dir string) {
			writeRegistration(t, dir, "a.json", validRegistration(), 0o600)
			value := validRegistration()
			value["targetId"], value["agentId"], value["stanza"] = "project-e", "agent-e", "project-e"
			writeRegistration(t, dir, "b.json", value, 0o600)
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			setup(dir)
			if _, err := loadClusterRegistrations(dir); err == nil {
				t.Fatal("unsafe registration was accepted")
			}
		})
	}
}
