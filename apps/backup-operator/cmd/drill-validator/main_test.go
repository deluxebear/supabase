package main

import (
	"testing"
	"time"
)

func TestParseRequiresIsolationFlags(t *testing.T) {
	env := func(string) string { return "" }
	valid := []string{"--pgdata", "/var/lib/backup-drill/project-a-20261012T060000Z", "--target-time", "2026-10-12T06:00:00Z", "--expected-system-id", "1", "--expected-history-id", "1", "--require-read-only", "--require-target-data", "--network=disabled"}
	opts, err := parse(valid, env)
	if err != nil || opts.user != "postgres" || !opts.targetTime.Equal(time.Date(2026, 10, 12, 6, 0, 0, 0, time.UTC)) {
		t.Fatalf("opts = %+v, err = %v", opts, err)
	}
	for name, args := range map[string][]string{
		"network allowed":   append(append([]string{}, valid[:len(valid)-1]...), "--network=enabled"),
		"relative pgdata":   append([]string{"--pgdata", "drill"}, valid[2:]...),
		"missing read-only": {"--pgdata", "/drill", "--target-time", "2026-10-12T06:00:00Z", "--expected-system-id", "1", "--expected-history-id", "1", "--require-target-data", "--network=disabled"},
		"extra argument":    append(append([]string{}, valid...), "extra"),
	} {
		if _, err := parse(args, env); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
	if _, err := parse(valid, func(string) string { return "postgres' or 1" }); err == nil {
		t.Fatal("an unsafe user was accepted")
	}
}
