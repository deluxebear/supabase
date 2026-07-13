package writefence

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

func ConfigurationRevision(adapter string) string {
	entries := make([]string, 0, len(RequiredEntryPoints))
	for _, entry := range RequiredEntryPoints {
		entries = append(entries, string(entry))
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(adapter) + "\x00" + strings.Join(entries, "\x00")))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// NewCommandEntryPoints enrolls exactly the seven Supabase writer surfaces.
// The command binary and every argv vector are fixed at Agent startup; task
// payloads cannot add a unit, Compose service, entry point, or action.
func NewCommandEntryPoints(runner CommandRunner, binary string) (map[EntryPoint]Gate, error) {
	if runner == nil || binary == "" {
		return nil, errors.New("write fence command runner and binary are required")
	}
	result := make(map[EntryPoint]Gate, len(RequiredEntryPoints))
	for _, entry := range RequiredEntryPoints {
		block := Command{Binary: binary, Args: []string{string(entry), "block"}}
		status := Command{Binary: binary, Args: []string{string(entry), "status"}}
		unblock := Command{Binary: binary, Args: []string{string(entry), "unblock"}}
		result[entry] = CommandGate{
			Runner: runner, AllowedBinaries: []string{binary}, AllowedCommands: []Command{block, status, unblock},
			Block: block, Status: status, Unblock: unblock,
		}.AsGate()
	}
	return result, nil
}
