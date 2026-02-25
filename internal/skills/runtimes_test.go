package skills

import (
	"strings"
	"testing"
)

func TestExtractVersion(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"Python 3.12.1", "3.12.1"},
		{"v22.11.0", "22.11.0"},
		{"go version go1.23.4 linux/amd64", "1.23.4"},
		{"rustc 1.75.0 (82e1608df 2023-12-21)", "1.75.0"},
		{"GNU bash, version 5.2.15(1)-release (x86_64-pc-linux-gnu)", "5.2.15(1)-release"},
		{"Bun 1.2.0", "1.2.0"},
		{"deno 1.40.0 (release, x86_64-unknown-linux-gnu)", "1.40.0"},
	}

	for _, tt := range tests {
		got := extractVersion(tt.input)
		if got != tt.want {
			t.Errorf("extractVersion(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestExtractVersionMultiline(t *testing.T) {
	input := "Python 3.12.1\nsome other output"
	got := extractVersion(input)
	if got != "3.12.1" {
		t.Errorf("got %q, want %q", got, "3.12.1")
	}
}

func TestDetectRuntimes(t *testing.T) {
	caps := DetectRuntimes("none")

	if caps.Sandbox != "none" {
		t.Errorf("sandbox = %q, want %q", caps.Sandbox, "none")
	}

	// We can't predict what's installed, but bash should be present on most systems
	if _, ok := caps.Runtimes["bash"]; !ok {
		t.Log("warning: bash not detected (unusual)")
	}

	// Just verify the structure works
	if caps.Runtimes == nil {
		t.Error("Runtimes should not be nil")
	}
}

func TestRuntimeCapabilitiesPrompt(t *testing.T) {
	caps := &RuntimeCapabilities{
		Sandbox: "none",
		Runtimes: map[string]string{
			"python3": "3.12.1",
			"go":      "1.23",
			"bash":    "5.2",
		},
		CanBuild:  []string{"go"},
		HasDocker: true,
	}

	section := caps.SystemPromptSection()

	if !strings.Contains(section, "## Runtime Environment") {
		t.Error("missing header")
	}
	if !strings.Contains(section, "Sandbox: none") {
		t.Error("missing sandbox info")
	}
	if !strings.Contains(section, "python3 (3.12.1)") {
		t.Error("missing python3")
	}
	if !strings.Contains(section, "go (1.23)") {
		t.Error("missing go")
	}
	if !strings.Contains(section, "Docker: available") {
		t.Error("missing docker info")
	}
}

func TestRuntimeCapabilitiesPromptEmpty(t *testing.T) {
	caps := &RuntimeCapabilities{
		Sandbox:  "none",
		Runtimes: map[string]string{},
	}
	if caps.SystemPromptSection() != "" {
		t.Error("empty runtimes should produce no output")
	}
}
