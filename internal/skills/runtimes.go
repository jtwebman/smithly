package skills

import (
	"fmt"
	"os/exec"
	"sort"
	"strings"
)

// RuntimeCapabilities describes what languages and tools are available on this machine.
type RuntimeCapabilities struct {
	Sandbox   string            // "none", "docker", "fly"
	Runtimes  map[string]string // name → version ("python3" → "3.12.1", "go" → "1.23")
	CanBuild  []string          // compiled languages available ("go", "rust")
	HasDocker bool
}

// runtimeCheck defines how to detect a runtime.
type runtimeCheck struct {
	name     string
	cmd      string
	args     []string
	canBuild bool // true for compiled languages (go, rust)
}

var runtimeChecks = []runtimeCheck{
	{"python3", "python3", []string{"--version"}, false},
	{"node", "node", []string{"--version"}, false},
	{"bun", "bun", []string{"--version"}, false},
	{"deno", "deno", []string{"--version"}, false},
	{"go", "go", []string{"version"}, true},
	{"rust", "rustc", []string{"--version"}, true},
	{"elixir", "elixir", []string{"--version"}, true},
	{"bash", "bash", []string{"--version"}, false},
}

// DetectRuntimes checks what languages and tools are available.
func DetectRuntimes(sandbox string) *RuntimeCapabilities {
	caps := &RuntimeCapabilities{
		Sandbox:  sandbox,
		Runtimes: make(map[string]string),
	}

	for _, check := range runtimeChecks {
		version := detectVersion(check.cmd, check.args)
		if version != "" {
			caps.Runtimes[check.name] = version
			if check.canBuild {
				caps.CanBuild = append(caps.CanBuild, check.name)
			}
		}
	}

	// Check Docker
	if _, err := exec.LookPath("docker"); err == nil {
		caps.HasDocker = true
	}

	return caps
}

// detectVersion runs a command and extracts a version string from its output.
func detectVersion(cmd string, args []string) string {
	path, err := exec.LookPath(cmd)
	if err != nil {
		return ""
	}
	_ = path

	out, err := exec.Command(cmd, args...).CombinedOutput()
	if err != nil {
		return ""
	}
	return extractVersion(string(out))
}

// extractVersion pulls a version number from command output.
// Handles formats like "Python 3.12.1", "v22.11.0", "go version go1.23 linux/amd64", "rustc 1.75.0"
func extractVersion(output string) string {
	output = strings.TrimSpace(output)
	// Take first line only
	if idx := strings.IndexByte(output, '\n'); idx >= 0 {
		output = output[:idx]
	}

	// Try to find a version pattern (digits.digits or vDigits.digits or goDigits.digits)
	for word := range strings.FieldsSeq(output) {
		word = strings.TrimPrefix(word, "v")
		word = strings.TrimPrefix(word, "go")
		if word != "" && word[0] >= '0' && word[0] <= '9' && strings.Contains(word, ".") {
			return word
		}
	}

	return strings.TrimSpace(output)
}

// SystemPromptSection returns a markdown section describing available runtimes
// for inclusion in the agent's system prompt.
func (c *RuntimeCapabilities) SystemPromptSection() string {
	if len(c.Runtimes) == 0 {
		return ""
	}

	var lines []string
	lines = append(lines, "## Runtime Environment")
	lines = append(lines, fmt.Sprintf("Sandbox: %s", c.Sandbox))

	// Sort runtime names for deterministic output
	names := make([]string, 0, len(c.Runtimes))
	for name := range c.Runtimes {
		names = append(names, name)
	}
	sort.Strings(names)

	var runtimes []string
	for _, name := range names {
		runtimes = append(runtimes, fmt.Sprintf("%s (%s)", name, c.Runtimes[name]))
	}
	lines = append(lines, fmt.Sprintf("Available runtimes: %s", strings.Join(runtimes, ", ")))

	if c.HasDocker {
		lines = append(lines, "Docker: available")
	}

	return strings.Join(lines, "\n")
}
