package recoverability

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const defaultWALSegmentSize uint64 = 16 << 20

type walSegment struct {
	name     string
	timeline uint32
	ordinal  uint64
	through  time.Time
}

func Evaluate(observation Observation) Window {
	window := Window{Confidence: Unknown, BackupLabel: observation.Backup.Label, Repository: observation.Repository}
	fail := func(reason string) Window { window.Reasons = append(window.Reasons, reason); return window }
	if err := validateRepository(observation); err != nil {
		return fail(err.Error())
	}
	if observation.Backup.Label == "" || observation.Backup.DatabaseSystemID == 0 || observation.Backup.DatabaseHistoryID == 0 {
		return fail("backup lineage is incomplete")
	}
	if !validUTC(observation.Backup.StartedAt) || !validUTC(observation.Backup.CompletedAt) || observation.Backup.CompletedAt.Before(observation.Backup.StartedAt) {
		return fail("backup timestamps must be ordered UTC values")
	}
	segmentSize := observation.WALSegmentSize
	if segmentSize == 0 {
		segmentSize = defaultWALSegmentSize
	}
	if segmentSize < 1<<20 || (uint64(1)<<32)%segmentSize != 0 {
		return fail("invalid WAL segment size")
	}
	start, err := parseWAL(observation.Backup.ArchiveStart, segmentSize)
	if err != nil {
		return fail("invalid backup archive start")
	}
	stop, err := parseWAL(observation.Backup.ArchiveStop, segmentSize)
	if err != nil {
		return fail("invalid backup archive stop")
	}
	if start.timeline != stop.timeline || stop.ordinal < start.ordinal {
		return fail("backup archive bounds cross a timeline or are reversed")
	}
	segmentsByTimeline := map[uint32]map[uint64]walSegment{}
	for _, raw := range observation.Archive.Segments {
		segment, err := parseWAL(raw.Name, segmentSize)
		if err != nil {
			return fail("archive contains an invalid WAL segment")
		}
		if !validUTC(raw.RecoverableThrough) {
			return fail("WAL recoverable-through timestamps must be UTC")
		}
		segment.through = raw.RecoverableThrough
		if segmentsByTimeline[segment.timeline] == nil {
			segmentsByTimeline[segment.timeline] = map[uint64]walSegment{}
		}
		if _, duplicate := segmentsByTimeline[segment.timeline][segment.ordinal]; duplicate {
			return fail("archive contains a duplicate WAL segment")
		}
		segmentsByTimeline[segment.timeline][segment.ordinal] = segment
	}
	history := map[uint32]TimelineHistory{}
	for _, item := range observation.Archive.History {
		if item.Timeline < 2 || item.Parent == 0 || item.Parent == item.Timeline {
			return fail("timeline history is invalid")
		}
		if _, exists := history[item.Timeline]; exists {
			return fail("timeline history contains duplicates")
		}
		history[item.Timeline] = item
	}
	current := observation.Archive.CurrentTimeline
	if current == 0 {
		return fail("current timeline is unknown")
	}
	lineage, switches, err := timelineLineage(start.timeline, current, history, segmentSize)
	if err != nil {
		return fail(err.Error())
	}
	fromOrdinal := start.ordinal
	var until time.Time
	var previousThrough time.Time
	for index, timeline := range lineage {
		toOrdinal := uint64(0)
		if index < len(lineage)-1 {
			toOrdinal = switches[lineage[index+1]]
			if index == 0 && toOrdinal < stop.ordinal {
				return fail("timeline switched before the backup archive stop WAL")
			}
		} else {
			for ordinal := range segmentsByTimeline[timeline] {
				if ordinal >= fromOrdinal && ordinal > toOrdinal {
					toOrdinal = ordinal
				}
			}
		}
		if toOrdinal < fromOrdinal {
			return fail(fmt.Sprintf("timeline %08X has no WAL at the required switch", timeline))
		}
		for ordinal := fromOrdinal; ordinal <= toOrdinal; ordinal++ {
			segment, ok := segmentsByTimeline[timeline][ordinal]
			if !ok {
				return fail(fmt.Sprintf("WAL gap on timeline %08X at ordinal %d", timeline, ordinal))
			}
			if !previousThrough.IsZero() && segment.through.Before(previousThrough) {
				return fail("WAL recoverable-through timestamps regress within the lineage")
			}
			previousThrough = segment.through
			if segment.through.After(until) {
				until = segment.through
			}
			if ordinal == ^uint64(0) {
				break
			}
		}
		if index < len(lineage)-1 {
			fromOrdinal = switches[lineage[index+1]]
		}
	}
	if _, ok := segmentsByTimeline[stop.timeline][stop.ordinal]; !ok {
		return fail("backup archive stop WAL is missing")
	}
	if until.Before(observation.Backup.CompletedAt) {
		return fail("WAL observations do not reach backup completion")
	}
	window.From, window.Until, window.Confidence = observation.Backup.CompletedAt, until, Inferred
	if observation.Drill != nil {
		if err := validateDrill(*observation.Drill, observation, window); err != nil {
			window.Reasons = append(window.Reasons, err.Error())
		} else {
			window.Confidence = DrillVerified
			window.DrillID = observation.Drill.ID
		}
	}
	return window
}

func validateRepository(o Observation) error {
	if o.Repository.Fingerprint == "" || o.Repository.Revision == "" {
		return errors.New("repository identity is incomplete")
	}
	if o.Backup.RepositoryIdentity != o.Repository || o.Archive.RepositoryIdentity != o.Repository {
		return errors.New("repository revision or fingerprint drift invalidates recoverability evidence")
	}
	return nil
}

func validateDrill(drill DrillRecord, o Observation, window Window) error {
	if drill.ID == "" || !drill.Passed || drill.EvidenceDigest == "" {
		return errors.New("restore drill has no successful durable evidence")
	}
	if !validUTC(drill.TargetTime) || !validUTC(drill.CompletedAt) || drill.CompletedAt.Before(drill.TargetTime) {
		return errors.New("restore drill timestamps are invalid")
	}
	if drill.TargetTime.Before(window.From) || drill.TargetTime.After(window.Until) {
		return errors.New("restore drill target is outside the inferred window")
	}
	expected := DrillLineage{BackupLabel: o.Backup.Label, DatabaseSystemID: o.Backup.DatabaseSystemID, DatabaseHistoryID: o.Backup.DatabaseHistoryID, RepositoryIdentity: o.Repository}
	if drill.Lineage != expected {
		return errors.New("restore drill lineage does not match current backup evidence")
	}
	return nil
}

func timelineLineage(base, current uint32, history map[uint32]TimelineHistory, segmentSize uint64) ([]uint32, map[uint32]uint64, error) {
	lineage := []uint32{current}
	switches := map[uint32]uint64{}
	seen := map[uint32]bool{current: true}
	for current != base {
		item, ok := history[current]
		if !ok {
			return nil, nil, fmt.Errorf("timeline %08X has no declared parent history", current)
		}
		if seen[item.Parent] {
			return nil, nil, errors.New("timeline history contains a cycle")
		}
		ordinal, err := parseLSNOrdinal(item.SwitchLSN, segmentSize)
		if err != nil {
			return nil, nil, fmt.Errorf("timeline %08X has invalid switch LSN", current)
		}
		switches[current] = ordinal
		current = item.Parent
		seen[current] = true
		lineage = append(lineage, current)
	}
	for left, right := 0, len(lineage)-1; left < right; left, right = left+1, right-1 {
		lineage[left], lineage[right] = lineage[right], lineage[left]
	}
	return lineage, switches, nil
}

func parseWAL(name string, segmentSize uint64) (walSegment, error) {
	if len(name) != 24 {
		return walSegment{}, errors.New("WAL name must contain 24 hex digits")
	}
	parse := func(value string, bits int) (uint64, error) { return strconv.ParseUint(value, 16, bits) }
	timeline, err := parse(name[:8], 32)
	if err != nil || timeline == 0 {
		return walSegment{}, errors.New("invalid WAL timeline")
	}
	log, err := parse(name[8:16], 32)
	if err != nil {
		return walSegment{}, err
	}
	segment, err := parse(name[16:], 32)
	if err != nil {
		return walSegment{}, err
	}
	segmentsPerLog := (uint64(1) << 32) / segmentSize
	if segment >= segmentsPerLog {
		return walSegment{}, errors.New("WAL segment index exceeds segment size")
	}
	return walSegment{name: strings.ToUpper(name), timeline: uint32(timeline), ordinal: log*segmentsPerLog + segment}, nil
}
func parseLSNOrdinal(lsn string, segmentSize uint64) (uint64, error) {
	highText, lowText, ok := strings.Cut(lsn, "/")
	if !ok {
		return 0, errors.New("invalid LSN")
	}
	high, err := strconv.ParseUint(highText, 16, 32)
	if err != nil {
		return 0, err
	}
	low, err := strconv.ParseUint(lowText, 16, 32)
	if err != nil {
		return 0, err
	}
	return (high*(uint64(1)<<32) + low) / segmentSize, nil
}
func validUTC(value time.Time) bool { return !value.IsZero() && value.Location() == time.UTC }
