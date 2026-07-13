package recoverability

import (
	"fmt"
	"testing"
	"time"
)

func wal(timeline uint32, ordinal uint64) string {
	return fmt.Sprintf("%08X%08X%08X", timeline, ordinal/256, ordinal%256)
}

func baseObservation() Observation {
	repository := RepositoryIdentity{Fingerprint: "repo-fingerprint", Revision: "repo-info-sha256:v1"}
	backupCompleted := time.Date(2026, 7, 13, 1, 0, 0, 0, time.UTC)
	return Observation{
		Repository: repository,
		Backup:     BackupObservation{Label: "20260713-000000F", StartedAt: backupCompleted.Add(-time.Hour), CompletedAt: backupCompleted, ArchiveStart: wal(1, 1), ArchiveStop: wal(1, 2), DatabaseSystemID: 42, DatabaseHistoryID: 7, RepositoryIdentity: repository},
		Archive: ArchiveObservation{CurrentTimeline: 1, RepositoryIdentity: repository, Segments: []ArchiveSegment{
			{Name: wal(1, 1), RecoverableThrough: backupCompleted},
			{Name: wal(1, 2), RecoverableThrough: backupCompleted.Add(time.Minute)},
			{Name: wal(1, 3), RecoverableThrough: backupCompleted.Add(2 * time.Minute)},
		}},
	}
}

func TestContinuousSegmentsAreInferredWithoutUsingOnlyBounds(t *testing.T) {
	window := Evaluate(baseObservation())
	if window.Confidence != Inferred || !window.Until.Equal(time.Date(2026, 7, 13, 1, 2, 0, 0, time.UTC)) {
		t.Fatalf("window: %#v", window)
	}
}

func TestDeletedIntermediateWALMakesWindowUnknown(t *testing.T) {
	observation := baseObservation()
	observation.Archive.Segments = append(observation.Archive.Segments[:1], observation.Archive.Segments[2:]...)
	window := Evaluate(observation)
	if window.Confidence != Unknown || len(window.Reasons) == 0 {
		t.Fatalf("gap was accepted: %#v", window)
	}
}

func TestDeclaredTimelineSwitchIsContinuous(t *testing.T) {
	observation := baseObservation()
	completed := observation.Backup.CompletedAt
	observation.Archive.CurrentTimeline = 2
	observation.Archive.History = []TimelineHistory{{Timeline: 2, Parent: 1, SwitchLSN: "0/02000000"}}
	observation.Archive.Segments = []ArchiveSegment{
		{Name: wal(1, 1), RecoverableThrough: completed}, {Name: wal(1, 2), RecoverableThrough: completed.Add(time.Minute)},
		{Name: wal(2, 2), RecoverableThrough: completed.Add(time.Minute)}, {Name: wal(2, 3), RecoverableThrough: completed.Add(2 * time.Minute)},
	}
	if window := Evaluate(observation); window.Confidence != Inferred {
		t.Fatalf("declared timeline switch rejected: %#v", window)
	}
	observation.Archive.History = nil
	if window := Evaluate(observation); window.Confidence != Unknown {
		t.Fatalf("undeclared timeline switch accepted: %#v", window)
	}
}

func TestRepositoryRevisionDriftInvalidatesEvidence(t *testing.T) {
	observation := baseObservation()
	observation.Repository.Revision = "repo-info-sha256:v2"
	if window := Evaluate(observation); window.Confidence != Unknown {
		t.Fatalf("revision drift accepted: %#v", window)
	}
}

func TestMatchingDrillPromotesAndLineageMismatchDoesNot(t *testing.T) {
	observation := baseObservation()
	observation.Drill = &DrillRecord{ID: "drill-1", TargetTime: observation.Backup.CompletedAt.Add(time.Minute), CompletedAt: observation.Backup.CompletedAt.Add(10 * time.Minute), Passed: true, EvidenceDigest: "sha256:evidence", Lineage: DrillLineage{BackupLabel: observation.Backup.Label, DatabaseSystemID: 42, DatabaseHistoryID: 7, RepositoryIdentity: observation.Repository}}
	window := Evaluate(observation)
	if window.Confidence != DrillVerified || window.DrillID != "drill-1" {
		t.Fatalf("drill not applied: %#v", window)
	}
	observation.Drill.Lineage.DatabaseSystemID = 99
	window = Evaluate(observation)
	if window.Confidence != Inferred || len(window.Reasons) == 0 {
		t.Fatalf("lineage mismatch promoted drill: %#v", window)
	}
}

func TestNonUTCBoundaryIsUnknown(t *testing.T) {
	observation := baseObservation()
	observation.Backup.CompletedAt = observation.Backup.CompletedAt.In(time.FixedZone("offset", 3600))
	if window := Evaluate(observation); window.Confidence != Unknown {
		t.Fatalf("non-UTC boundary accepted: %#v", window)
	}
}
