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
