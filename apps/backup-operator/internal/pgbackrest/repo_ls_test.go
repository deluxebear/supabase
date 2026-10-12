package pgbackrest

import (
	"reflect"
	"testing"
	"time"
)

func TestArchiveListCommandIsFixed(t *testing.T) {
	command, err := Builder{Binary: DefaultBinary, ConfigPath: "/etc/pgbackrest/pgbackrest.conf"}.ArchiveList("project-a", "17-1")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--config=/etc/pgbackrest/pgbackrest.conf", "--stanza=project-a", "--output=json", "--recurse", "repo-ls", "archive/project-a/17-1"}
	if !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("args = %v", command.Args)
	}
	for _, id := range []string{"", "17", "17-1/../x", "../17-1"} {
		if _, err := (Builder{}).ArchiveList("project-a", id); err == nil {
			t.Fatalf("archive ID %q was accepted", id)
		}
	}
}

func TestParseArchiveListKeepsSegmentsAndTimelines(t *testing.T) {
	listing, err := ParseArchiveList([]byte(`{
		".":{"type":"path"},
		"0000000100000001":{"type":"path"},
		"0000000100000001/000000010000000100000047-c02e70a91a9c260245046a650a1e76fd63016bf2.zst":{"type":"file","size":1,"time":1791780840},
		"0000000100000001/000000010000000100000046-58e9a136712ba967c72e42834cc5226665ff17d1.zst":{"type":"file","size":1,"time":1791780838},
		"0000000100000001/000000010000000100000048.00000028.backup":{"type":"file","size":400,"time":1791780851},
		"0000000200000001/000000020000000100000049.partial-76658dcb9980769cc6254cb6ee4577c463863b06.zst":{"type":"file","size":1,"time":1791780869},
		"00000002.history":{"type":"file","size":42,"time":1791780870}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	want := ArchiveListing{
		Segments: []ArchivedSegment{
			{Name: "000000010000000100000046", StoredAt: time.Unix(1791780838, 0).UTC()},
			{Name: "000000010000000100000047", StoredAt: time.Unix(1791780840, 0).UTC()},
		},
		Timelines: []uint32{2},
	}
	if !reflect.DeepEqual(listing, want) {
		t.Fatalf("listing = %+v", listing)
	}
	if _, err := ParseArchiveList([]byte(`[]`)); err == nil {
		t.Fatal("non-object listing was accepted")
	}
}

func TestTimelineHistory(t *testing.T) {
	command, err := Builder{Binary: DefaultBinary}.TimelineHistoryFile("project-a", "17-1", 3)
	if err != nil || command.Args[len(command.Args)-2] != "repo-get" || command.Args[len(command.Args)-1] != "archive/project-a/17-1/00000003.history" {
		t.Fatalf("command = %v, err = %v", command.Args, err)
	}
	if _, err := (Builder{}).TimelineHistoryFile("project-a", "17-1", 1); err == nil {
		t.Fatal("timeline 1 has no history file but was accepted")
	}
	got, err := ParseTimelineHistory([]byte("1\t0/5000148\tno recovery target specified\n\n2\t1/4A0000A0\tbefore 2026-10-12 06:00:00+00\n"), 3)
	if err != nil || got != (TimelineSwitch{Timeline: 3, Parent: 2, SwitchLSN: "1/4A0000A0"}) {
		t.Fatalf("history = %+v, err = %v", got, err)
	}
	for _, bad := range []string{"", "x\t0/1\n", "3\t0/1\tsame timeline\n"} {
		if _, err := ParseTimelineHistory([]byte(bad), 3); err == nil {
			t.Fatalf("history %q was accepted", bad)
		}
	}
}

func TestRestoreFollowsTheRequestedTimeline(t *testing.T) {
	target := time.Unix(1791780010, 0).UTC()
	command, err := Builder{Binary: DefaultBinary}.Restore("project-a", RestoreOptions{PGData: "/var/lib/postgresql/data", TargetTime: &target, TargetAction: "promote", TargetTimeline: 1})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, arg := range command.Args {
		found = found || arg == "--target-timeline=1"
	}
	if !found {
		t.Fatalf("restore args %v do not pin the timeline", command.Args)
	}
	command, _ = Builder{Binary: DefaultBinary}.Restore("project-a", RestoreOptions{PGData: "/var/lib/postgresql/data", TargetTime: &target})
	for _, arg := range command.Args {
		if arg == "--target-timeline=0" {
			t.Fatal("an unset timeline was passed to pgBackRest")
		}
	}
}
