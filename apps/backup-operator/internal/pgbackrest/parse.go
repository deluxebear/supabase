package pgbackrest

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

type StanzaInfo struct {
	Name            string
	StatusCode      int
	StatusMessage   string
	DatabaseVersion string
	SystemID        uint64
	Backups         []BackupInfo
}
type BackupInfo struct {
	Label, Type, Prior, ArchiveStart, ArchiveStop, LSNStart, LSNStop string
	StartedAt, StoppedAt                                             time.Time
	Size, RepositorySize                                             int64
}

func ParseInfo(data []byte) ([]StanzaInfo, error) {
	var raw []struct {
		Name   string `json:"name"`
		Status struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"status"`
		DB []struct {
			Version  string      `json:"version"`
			SystemID json.Number `json:"system-id"`
		} `json:"db"`
		Backup []struct {
			Label   string `json:"label"`
			Type    string `json:"type"`
			Prior   string `json:"prior"`
			Archive struct {
				Start string `json:"start"`
				Stop  string `json:"stop"`
			} `json:"archive"`
			LSN struct {
				Start string `json:"start"`
				Stop  string `json:"stop"`
			} `json:"lsn"`
			Timestamp struct {
				Start int64 `json:"start"`
				Stop  int64 `json:"stop"`
			} `json:"timestamp"`
			Info struct {
				Size       int64 `json:"size"`
				Repository struct {
					Size int64 `json:"size"`
				} `json:"repository"`
			} `json:"info"`
		} `json:"backup"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&raw); err != nil {
		return nil, fmt.Errorf("parse pgBackRest info: %w", err)
	}
	result := make([]StanzaInfo, 0, len(raw))
	for _, stanza := range raw {
		if stanza.Name == "" {
			return nil, errors.New("pgBackRest info contains unnamed stanza")
		}
		info := StanzaInfo{Name: stanza.Name, StatusCode: stanza.Status.Code, StatusMessage: stanza.Status.Message}
		if len(stanza.DB) > 0 {
			info.DatabaseVersion = stanza.DB[len(stanza.DB)-1].Version
			id, err := parseInt64(stanza.DB[len(stanza.DB)-1].SystemID.String())
			if err != nil {
				return nil, fmt.Errorf("parse system ID: %w", err)
			}
			info.SystemID = uint64(id)
		}
		for _, backup := range stanza.Backup {
			info.Backups = append(info.Backups, BackupInfo{Label: backup.Label, Type: backup.Type, Prior: backup.Prior, ArchiveStart: backup.Archive.Start, ArchiveStop: backup.Archive.Stop, LSNStart: backup.LSN.Start, LSNStop: backup.LSN.Stop, StartedAt: time.Unix(backup.Timestamp.Start, 0).UTC(), StoppedAt: time.Unix(backup.Timestamp.Stop, 0).UTC(), Size: backup.Info.Size, RepositorySize: backup.Info.Repository.Size})
		}
		result = append(result, info)
	}
	return result, nil
}

type Manifest struct{ Sections map[string]map[string]string }

func ParseManifest(data []byte) (Manifest, error) {
	manifest := Manifest{Sections: map[string]map[string]string{}}
	section := ""
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 4096), 4<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(line[1 : len(line)-1])
			if section == "" {
				return Manifest{}, errors.New("empty manifest section")
			}
			manifest.Sections[section] = map[string]string{}
			continue
		}
		if section == "" {
			return Manifest{}, errors.New("manifest key outside section")
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) == "" {
			return Manifest{}, fmt.Errorf("invalid manifest line %q", line)
		}
		manifest.Sections[section][strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	if err := scanner.Err(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

type HistoryEntry struct {
	Label      string `json:"label"`
	Type       string `json:"type"`
	StartedAt  int64  `json:"start"`
	StoppedAt  int64  `json:"stop"`
	DatabaseID uint64 `json:"database_id"`
}

func ParseHistory(data []byte) ([]HistoryEntry, error) {
	var entries []HistoryEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("parse backup history: %w", err)
	}
	for _, entry := range entries {
		if entry.Label == "" || entry.StoppedAt < entry.StartedAt {
			return nil, errors.New("invalid backup history entry")
		}
	}
	return entries, nil
}

type DatabaseHistoryEntry struct {
	ID       uint64
	Version  string
	SystemID uint64
}

// ParseDatabaseHistory reads the db:history section used by backup.info and
// archive.info. Values are JSON objects keyed by the pgBackRest database ID.
func ParseDatabaseHistory(data []byte) ([]DatabaseHistoryEntry, error) {
	manifest, err := ParseManifest(data)
	if err != nil {
		return nil, err
	}
	section, ok := manifest.Sections["db:history"]
	if !ok {
		return nil, errors.New("pgBackRest history section is missing")
	}
	entries := make([]DatabaseHistoryEntry, 0, len(section))
	for idText, encoded := range section {
		id, err := parseInt64(idText)
		if err != nil || id < 1 {
			return nil, fmt.Errorf("invalid pgBackRest history ID %q", idText)
		}
		var raw struct {
			Version  string      `json:"db-version"`
			SystemID json.Number `json:"db-system-id"`
		}
		decoder := json.NewDecoder(strings.NewReader(encoded))
		decoder.UseNumber()
		if err := decoder.Decode(&raw); err != nil {
			return nil, fmt.Errorf("parse pgBackRest history %d: %w", id, err)
		}
		systemID, err := parseInt64(raw.SystemID.String())
		if err != nil || systemID < 1 || raw.Version == "" {
			return nil, fmt.Errorf("invalid pgBackRest history %d", id)
		}
		entries = append(entries, DatabaseHistoryEntry{ID: uint64(id), Version: raw.Version, SystemID: uint64(systemID)})
	}
	return entries, nil
}
