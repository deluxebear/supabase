package app

import "testing"

func TestParseMode(t *testing.T) {
	for _, value := range []string{"operator", "agent", "all"} {
		if _, err := ParseMode(value); err != nil {
			t.Fatalf("ParseMode(%q): %v", value, err)
		}
	}
	if _, err := ParseMode("restore"); err == nil {
		t.Fatal("expected invalid mode to fail")
	}
}
