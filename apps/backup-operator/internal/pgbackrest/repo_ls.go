package pgbackrest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	archiveIDPattern  = regexp.MustCompile(`^[0-9]+-[0-9]+$`)
	walSegmentPattern = regexp.MustCompile(`(?:^|/)([0-9A-F]{24})-[0-9a-f]{40}(?:\.[a-z0-9]+)?$`)
	historyPattern    = regexp.MustCompile(`(?:^|/)([0-9A-F]{8})\.history(?:\.[a-z0-9]+)?$`)
)

// ArchiveListing is the WAL archive of one database history, as stored in the
// repository.
type ArchiveListing struct {
	Segments  []ArchivedSegment
	Timelines []uint32
}

// ArchivedSegment is a WAL segment and the time the repository stored it.
type ArchivedSegment struct {
	Name     string
	StoredAt time.Time
}

// ArchiveList lists the archive of one database history (for example
// "17-1"). The archive ID comes from typed info, never from task input.
func (b Builder) ArchiveList(stanza, archiveID string) (Command, error) {
	if !archiveIDPattern.MatchString(archiveID) {
		return Command{}, errors.New("invalid archive ID")
	}
	command, err := b.command(stanza, "repo-ls", "--output=json", "--recurse")
	if err != nil {
		return Command{}, err
	}
	command.Args = append(command.Args, "archive/"+stanza+"/"+archiveID)
	return command, nil
}

func (c Client) RunArchiveList(ctx context.Context, stanza, archiveID string) (ArchiveListing, error) {
	command, err := c.Builder.ArchiveList(stanza, archiveID)
	if err != nil {
		return ArchiveListing{}, err
	}
	out, err := c.execute(ctx, "repo-ls", command)
	if err != nil {
		return ArchiveListing{}, err
	}
	return ParseArchiveList(out.Stdout)
}

// ParseArchiveList keeps WAL segment files and timeline history files. Partial
// segments and backup labels are ignored.
func ParseArchiveList(data []byte) (ArchiveListing, error) {
	var raw map[string]struct {
		Type string `json:"type"`
		Time int64  `json:"time"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&raw); err != nil {
		return ArchiveListing{}, fmt.Errorf("parse pgBackRest repo-ls: %w", err)
	}
	segments := map[string]time.Time{}
	timelines := map[uint32]struct{}{}
	for path, entry := range raw {
		if entry.Type != "file" || strings.Contains(path, ".partial") {
			continue
		}
		if match := walSegmentPattern.FindStringSubmatch(path); match != nil {
			stored := time.Unix(entry.Time, 0).UTC()
			if previous, ok := segments[match[1]]; !ok || stored.Before(previous) {
				segments[match[1]] = stored
			}
			continue
		}
		if match := historyPattern.FindStringSubmatch(path); match != nil {
			var timeline uint32
			if _, err := fmt.Sscanf(match[1], "%08X", &timeline); err == nil {
				timelines[timeline] = struct{}{}
			}
		}
	}
	listing := ArchiveListing{}
	for name, stored := range segments {
		listing.Segments = append(listing.Segments, ArchivedSegment{Name: name, StoredAt: stored})
	}
	sort.Slice(listing.Segments, func(i, j int) bool { return listing.Segments[i].Name < listing.Segments[j].Name })
	for timeline := range timelines {
		listing.Timelines = append(listing.Timelines, timeline)
	}
	sort.Slice(listing.Timelines, func(i, j int) bool { return listing.Timelines[i] < listing.Timelines[j] })
	return listing, nil
}

// TimelineSwitch is the parent and switch point of a timeline, from the last
// line of its history file.
type TimelineSwitch struct {
	Timeline  uint32
	Parent    uint32
	SwitchLSN string
}

// TimelineHistoryFile reads one timeline history file from the archive of a
// database history. pgBackRest decrypts and decompresses it.
func (b Builder) TimelineHistoryFile(stanza, archiveID string, timeline uint32) (Command, error) {
	if !archiveIDPattern.MatchString(archiveID) || timeline < 2 {
		return Command{}, errors.New("invalid archive ID or timeline")
	}
	command, err := b.command(stanza, "repo-get")
	if err != nil {
		return Command{}, err
	}
	command.Args = append(command.Args, fmt.Sprintf("archive/%s/%s/%08X.history", stanza, archiveID, timeline))
	return command, nil
}

func (c Client) RunTimelineHistory(ctx context.Context, stanza, archiveID string, timeline uint32) (TimelineSwitch, error) {
	command, err := c.Builder.TimelineHistoryFile(stanza, archiveID, timeline)
	if err != nil {
		return TimelineSwitch{}, err
	}
	out, err := c.execute(ctx, "repo-get", command)
	if err != nil {
		return TimelineSwitch{}, err
	}
	return ParseTimelineHistory(out.Stdout, timeline)
}

var historyLinePattern = regexp.MustCompile(`^([0-9]+)\s+([0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8})(?:\s.*)?$`)

// ParseTimelineHistory reads a PostgreSQL timeline history file. Its last
// entry names the timeline this one branched from and where.
func ParseTimelineHistory(data []byte, timeline uint32) (TimelineSwitch, error) {
	var last []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		match := historyLinePattern.FindStringSubmatch(line)
		if match == nil {
			return TimelineSwitch{}, errors.New("timeline history contains an invalid line")
		}
		last = match
	}
	if last == nil {
		return TimelineSwitch{}, errors.New("timeline history is empty")
	}
	var parent uint32
	if _, err := fmt.Sscanf(last[1], "%d", &parent); err != nil || parent == 0 || parent >= timeline {
		return TimelineSwitch{}, errors.New("timeline history names an invalid parent")
	}
	return TimelineSwitch{Timeline: timeline, Parent: parent, SwitchLSN: strings.ToUpper(last[2])}, nil
}
