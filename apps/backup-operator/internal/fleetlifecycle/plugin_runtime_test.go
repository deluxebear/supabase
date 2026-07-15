package fleetlifecycle

import (
	"strings"
	"testing"
)

func TestBoundedBufferCapsPluginOutput(t *testing.T) {
	buffer := boundedBuffer{limit: 4}
	input := []byte("123456")
	written, err := buffer.Write(input)
	if err != nil || written != len(input) || buffer.buffer.String() != "1234" || !buffer.exceeded {
		t.Fatalf("bounded plugin output writer = written %d, err %v, value %q, exceeded %t", written, err, buffer.buffer.String(), buffer.exceeded)
	}
}

func TestDecodePluginResponseRejectsTrailingDocument(t *testing.T) {
	_, err := decodePluginResponse(strings.NewReader(`{"observed":{}} {"observed":{}}`))
	if err == nil {
		t.Fatal("multiple lifecycle plugin response documents were accepted")
	}
}

func TestParseActionsRejectsUnknownAndDuplicateCapabilities(t *testing.T) {
	for _, values := range [][]string{{"runtime.restart", "runtime.restart"}, {"runtime.restart; rm -rf /"}, {}} {
		if _, err := ParseActions(values); err == nil {
			t.Fatalf("invalid lifecycle capabilities were accepted: %#v", values)
		}
	}
}
