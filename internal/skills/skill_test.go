package skills

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func writeSkill(t *testing.T, dir, manifest, instructions string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.toml"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "INSTRUCTIONS.md"), []byte(instructions), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestLoadSkill(t *testing.T) {
	dir := writeSkill(t, filepath.Join(t.TempDir(), "test-skill"),
		`[skill]
name = "test-skill"
version = "1.0.0"
description = "A test skill"
author = "tester"

[[triggers]]
type = "keyword"
pattern = "hello"
`,
		"When the user says hello, respond warmly.")

	s, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.Manifest.Skill.Name != "test-skill" {
		t.Errorf("name = %q", s.Manifest.Skill.Name)
	}
	if s.Manifest.Skill.Version != "1.0.0" {
		t.Errorf("version = %q", s.Manifest.Skill.Version)
	}
	if s.Content != "When the user says hello, respond warmly." {
		t.Errorf("content = %q", s.Content)
	}
	if len(s.Manifest.Triggers) != 1 {
		t.Fatalf("triggers = %d, want 1", len(s.Manifest.Triggers))
	}
	if s.Manifest.Triggers[0].Type != "keyword" {
		t.Errorf("trigger type = %q", s.Manifest.Triggers[0].Type)
	}
}

func TestLoadSkillMissingName(t *testing.T) {
	dir := writeSkill(t, filepath.Join(t.TempDir(), "bad-skill"),
		`[skill]
version = "1.0.0"
`,
		"content")

	_, err := Load(dir)
	if err == nil {
		t.Fatal("expected error for missing name")
	}
}

func TestLoadSkillBadTriggerType(t *testing.T) {
	dir := writeSkill(t, filepath.Join(t.TempDir(), "bad-trigger"),
		`[skill]
name = "bad"

[[triggers]]
type = "magic"
pattern = "foo"
`,
		"content")

	_, err := Load(dir)
	if err == nil {
		t.Fatal("expected error for unknown trigger type")
	}
}

func TestLoadSkillBadRegex(t *testing.T) {
	dir := writeSkill(t, filepath.Join(t.TempDir(), "bad-regex"),
		`[skill]
name = "bad-regex"

[[triggers]]
type = "regex"
pattern = "[invalid"
`,
		"content")

	_, err := Load(dir)
	if err == nil {
		t.Fatal("expected error for invalid regex")
	}
}

func TestMatchKeyword(t *testing.T) {
	s := &Skill{
		Manifest: Manifest{
			Triggers: []Trigger{{Type: "keyword", Pattern: "review"}},
		},
	}

	if !s.Matches("Please review this code") {
		t.Error("should match 'review'")
	}
	if !s.Matches("REVIEW my PR") {
		t.Error("should match case-insensitive")
	}
	if s.Matches("This is unrelated") {
		t.Error("should not match")
	}
}

func TestMatchRegex(t *testing.T) {
	re := mustCompileTrigger(t, "regex", `\bPR[- ]?\d+\b`)
	s := &Skill{
		Manifest: Manifest{
			Triggers: []Trigger{*re},
		},
	}

	if !s.Matches("Look at PR-123") {
		t.Error("should match PR-123")
	}
	if !s.Matches("Check PR 456 please") {
		t.Error("should match PR 456")
	}
	if s.Matches("This is a regular message") {
		t.Error("should not match")
	}
}

func TestMatchAlways(t *testing.T) {
	s := &Skill{
		Manifest: Manifest{
			Triggers: []Trigger{{Type: "always"}},
		},
	}

	if !s.Matches("anything at all") {
		t.Error("always trigger should match everything")
	}
	if !s.Matches("") {
		t.Error("always trigger should match empty string")
	}
}

func TestMatchNoTriggers(t *testing.T) {
	s := &Skill{
		Manifest: Manifest{},
	}

	if s.Matches("anything") {
		t.Error("no triggers should never match")
	}
}

func TestMatchMultipleTriggers(t *testing.T) {
	s := &Skill{
		Manifest: Manifest{
			Triggers: []Trigger{
				{Type: "keyword", Pattern: "review"},
				{Type: "keyword", Pattern: "check"},
			},
		},
	}

	if !s.Matches("review this") {
		t.Error("should match first trigger")
	}
	if !s.Matches("check that") {
		t.Error("should match second trigger")
	}
	if s.Matches("nothing relevant") {
		t.Error("should not match")
	}
}

func mustCompileTrigger(t *testing.T, typ, pattern string) *Trigger {
	t.Helper()
	compiled, err := compileRegex(pattern)
	if err != nil {
		t.Fatal(err)
	}
	return &Trigger{Type: typ, Pattern: pattern, compiled: compiled}
}

func compileRegex(pattern string) (*regexp.Regexp, error) {
	return regexp.Compile(pattern)
}
