// Package skills handles instruction skill loading, trigger matching,
// and injection into the agent's system prompt.
package skills

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/BurntSushi/toml"
)

// Skill represents a loaded instruction skill.
type Skill struct {
	Manifest Manifest
	Content  string // The instruction Markdown content
	Path     string // Directory path where the skill lives
}

// Manifest is the parsed manifest.toml for an instruction skill.
type Manifest struct {
	Skill    SkillMeta        `toml:"skill"`
	Triggers []Trigger        `toml:"triggers"`
	Requires *Requires        `toml:"requires"`
	Code     *CodeSkillConfig `toml:"code"`
}

// SkillMeta holds basic skill metadata.
type SkillMeta struct {
	Name        string `toml:"name"`
	Version     string `toml:"version"`
	Description string `toml:"description"`
	Author      string `toml:"author"`
	Type        string `toml:"type"` // "instruction" (default) or "code"
}

// Trigger defines when an instruction skill should be loaded into context.
type Trigger struct {
	// Type: "keyword", "regex", or "always"
	Type    string `toml:"type"`
	Pattern string `toml:"pattern"` // keyword or regex pattern (ignored for "always")

	compiled *regexp.Regexp // compiled regex (lazy)
}

// Requires declares what the skill needs to function.
type Requires struct {
	Tools   []string `toml:"tools"`   // Tool names the agent should have
	Domains []string `toml:"domains"` // Network domains the agent needs access to
	OAuth2  []string `toml:"oauth2"`  // Required OAuth2 provider names
}

// Load reads a skill from a directory containing manifest.toml and INSTRUCTIONS.md.
func Load(dir string) (*Skill, error) {
	manifestPath := filepath.Join(dir, "manifest.toml")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}

	var m Manifest
	if _, err := toml.Decode(string(data), &m); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}

	if m.Skill.Name == "" {
		return nil, fmt.Errorf("manifest missing skill.name")
	}

	// Validate triggers
	for i := range m.Triggers {
		t := &m.Triggers[i]
		switch t.Type {
		case "keyword", "regex", "always":
			// valid
		case "":
			return nil, fmt.Errorf("trigger %d missing type", i)
		default:
			return nil, fmt.Errorf("trigger %d: unknown type %q", i, t.Type)
		}
		if t.Type == "regex" {
			compiled, err := regexp.Compile(t.Pattern)
			if err != nil {
				return nil, fmt.Errorf("trigger %d: bad regex %q: %w", i, t.Pattern, err)
			}
			t.compiled = compiled
		}
	}

	// Code skills don't require INSTRUCTIONS.md
	var content string
	contentPath := filepath.Join(dir, "INSTRUCTIONS.md")
	if data, err := os.ReadFile(contentPath); err == nil {
		content = strings.TrimSpace(string(data))
	} else if m.Skill.Type != "code" {
		// Instruction skills require INSTRUCTIONS.md
		return nil, fmt.Errorf("read instructions: %w", err)
	}

	return &Skill{
		Manifest: m,
		Content:  content,
		Path:     dir,
	}, nil
}

// Matches returns true if this skill should be activated for the given user message.
func (s *Skill) Matches(message string) bool {
	if len(s.Manifest.Triggers) == 0 {
		return false
	}

	lower := strings.ToLower(message)

	for _, t := range s.Manifest.Triggers {
		switch t.Type {
		case "always":
			return true
		case "keyword":
			if strings.Contains(lower, strings.ToLower(t.Pattern)) {
				return true
			}
		case "regex":
			if t.compiled != nil && t.compiled.MatchString(message) {
				return true
			}
		}
	}
	return false
}
