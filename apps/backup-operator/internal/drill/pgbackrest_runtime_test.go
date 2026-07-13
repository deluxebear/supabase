package drill

import (
	"context"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/pgbackrest"
)

type fakeRestoreClient struct {
	stanza  string
	options pgbackrest.RestoreOptions
}

func (f *fakeRestoreClient) RunRestore(_ context.Context, stanza string, options pgbackrest.RestoreOptions) error {
	f.stanza, f.options = stanza, options
	return nil
}

type fakeWorkspace struct{ prepared, destroyed string }

func (f *fakeWorkspace) Prepare(_ context.Context, path string) error { f.prepared = path; return nil }
func (f *fakeWorkspace) Destroy(_ context.Context, path string) error { f.destroyed = path; return nil }

type fakeValidator struct{}

func (fakeValidator) ValidateIsolated(context.Context, string, Target) (map[string]string, error) {
	return map[string]string{"marker": "before-target"}, nil
}

func TestPGBackRestRuntimeUsesDedicatedReadOnlyWorkspace(t *testing.T) {
	target := drillTarget()
	client, workspace := &fakeRestoreClient{}, &fakeWorkspace{}
	runtime := PGBackRestRuntime{Client: client, Workspace: workspace, Validator: fakeValidator{}, Stanza: "contract", WorkspaceRoot: "/var/lib/backup-operator/drills", RepositoryReadOnly: true}
	evidence, err := runtime.RestoreIsolated(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	if workspace.prepared == "" || client.options.PGData != workspace.prepared || client.options.TargetTime == nil || client.options.TargetAction != "promote" || evidence.Checks["repositoryWrites"] != "disabled" {
		t.Fatalf("runtime evidence=%#v options=%#v workspace=%#v", evidence, client.options, workspace)
	}
	if err := runtime.DestroyIsolation(context.Background(), target); err != nil || workspace.destroyed != workspace.prepared {
		t.Fatalf("destroy=%q err=%v", workspace.destroyed, err)
	}
}

func TestPGBackRestRuntimeFailsClosedWithoutReadOnlyRepository(t *testing.T) {
	target := drillTarget()
	runtime := PGBackRestRuntime{Client: &fakeRestoreClient{}, Workspace: &fakeWorkspace{}, Validator: fakeValidator{}, Stanza: "contract", WorkspaceRoot: "/drills"}
	if _, err := runtime.RestoreIsolated(context.Background(), target); err == nil {
		t.Fatal("mutable repository accepted")
	}
	target.ClusterID = "../escape"
	if _, err := runtime.RestoreIsolated(context.Background(), target); err == nil {
		t.Fatal("unsafe workspace identity accepted")
	}
}
