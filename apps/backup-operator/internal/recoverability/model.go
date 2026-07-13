package recoverability

import "time"

type Confidence string

const (
	Unknown       Confidence = "unknown"
	Inferred      Confidence = "inferred"
	DrillVerified Confidence = "drill-verified"
)

type RepositoryIdentity struct {
	Fingerprint string
	Revision    string
}

type BackupObservation struct {
	Label              string
	Stanza             string
	StartedAt          time.Time
	CompletedAt        time.Time
	ArchiveStart       string
	ArchiveStop        string
	DatabaseSystemID   uint64
	DatabaseHistoryID  uint64
	RepositoryIdentity RepositoryIdentity
}

type ArchiveSegment struct {
	Name               string
	RecoverableThrough time.Time
}

type TimelineHistory struct {
	Timeline  uint32
	Parent    uint32
	SwitchLSN string
}

type ArchiveObservation struct {
	Segments           []ArchiveSegment
	History            []TimelineHistory
	CurrentTimeline    uint32
	RepositoryIdentity RepositoryIdentity
}

type DrillLineage struct {
	BackupLabel        string
	DatabaseSystemID   uint64
	DatabaseHistoryID  uint64
	RepositoryIdentity RepositoryIdentity
}

type DrillRecord struct {
	ID             string
	TargetTime     time.Time
	CompletedAt    time.Time
	Passed         bool
	EvidenceDigest string
	Lineage        DrillLineage
}

type Observation struct {
	Repository     RepositoryIdentity
	Backup         BackupObservation
	Archive        ArchiveObservation
	Drill          *DrillRecord
	WALSegmentSize uint64
}

type Window struct {
	From        time.Time
	Until       time.Time
	Confidence  Confidence
	Reasons     []string
	BackupLabel string
	Repository  RepositoryIdentity
	DrillID     string
}
