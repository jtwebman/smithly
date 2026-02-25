package skills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testSkill(name string, triggers ...Trigger) *Skill {
	return &Skill{
		Manifest: Manifest{
			Skill:    SkillMeta{Name: name},
			Triggers: triggers,
		},
		Content: "Instructions for " + name,
	}
}

func TestRegistryAddAndGet(t *testing.T) {
	r := NewRegistry()
	s := testSkill("test")

	if err := r.Add(s); err != nil {
		t.Fatalf("Add: %v", err)
	}

	got, ok := r.Get("test")
	if !ok {
		t.Fatal("skill not found")
	}
	if got.Manifest.Skill.Name != "test" {
		t.Errorf("name = %q", got.Manifest.Skill.Name)
	}
}

func TestRegistryAddDuplicate(t *testing.T) {
	r := NewRegistry()
	s := testSkill("dup")

	r.Add(s)
	if err := r.Add(s); err == nil {
		t.Error("expected error for duplicate skill")
	}
}

func TestRegistryRemove(t *testing.T) {
	r := NewRegistry()
	r.Add(testSkill("removeme"))

	if !r.Remove("removeme") {
		t.Error("Remove should return true for existing skill")
	}
	if r.Remove("removeme") {
		t.Error("Remove should return false for missing skill")
	}
	if _, ok := r.Get("removeme"); ok {
		t.Error("skill should be gone after Remove")
	}
}

func TestRegistryAll(t *testing.T) {
	r := NewRegistry()
	r.Add(testSkill("a"))
	r.Add(testSkill("b"))
	r.Add(testSkill("c"))

	all := r.All()
	if len(all) != 3 {
		t.Errorf("All() = %d skills, want 3", len(all))
	}
}

func TestRegistryMatch(t *testing.T) {
	r := NewRegistry()
	r.Add(testSkill("review", Trigger{Type: "keyword", Pattern: "review"}))
	r.Add(testSkill("summary", Trigger{Type: "keyword", Pattern: "summarize"}))
	r.Add(testSkill("safety", Trigger{Type: "always"}))

	// "review this code" should match review + safety
	matched := r.Match("review this code")
	names := map[string]bool{}
	for _, s := range matched {
		names[s.Manifest.Skill.Name] = true
	}
	if !names["review"] {
		t.Error("review skill should match")
	}
	if !names["safety"] {
		t.Error("safety skill should always match")
	}
	if names["summary"] {
		t.Error("summary skill should not match")
	}

	// "summarize the doc" should match summary + safety
	matched = r.Match("summarize the doc")
	names = map[string]bool{}
	for _, s := range matched {
		names[s.Manifest.Skill.Name] = true
	}
	if !names["summary"] {
		t.Error("summary skill should match")
	}
	if !names["safety"] {
		t.Error("safety skill should always match")
	}
}

func TestRegistrySummary(t *testing.T) {
	r := NewRegistry()
	review := testSkill("review", Trigger{Type: "keyword", Pattern: "review"})
	review.Manifest.Skill.Description = "Code review helper"
	r.Add(review)

	safety := testSkill("safety", Trigger{Type: "always"})
	safety.Manifest.Skill.Description = "Safety guidelines"
	r.Add(safety)

	summary := r.Summary()
	if summary == "" {
		t.Fatal("expected non-empty summary")
	}
	if !strings.Contains(summary, "## Available Skills") {
		t.Error("summary should contain header")
	}
	if !strings.Contains(summary, "review") {
		t.Error("summary should list review skill")
	}
	if !strings.Contains(summary, "Code review helper") {
		t.Error("summary should contain review description")
	}
	if !strings.Contains(summary, "safety") {
		t.Error("summary should list safety skill")
	}
	if !strings.Contains(summary, "read_skill") {
		t.Error("summary should mention read_skill tool")
	}
	// Should NOT contain full instructions
	if strings.Contains(summary, "Instructions for review") {
		t.Error("summary should not contain full instructions")
	}
}

func TestRegistrySummaryEmpty(t *testing.T) {
	r := NewRegistry()
	if s := r.Summary(); s != "" {
		t.Errorf("expected empty summary for no skills, got %q", s)
	}
}

func TestLoadExampleSkills(t *testing.T) {
	// Find the examples/skills directory relative to the project root
	examplesDir := filepath.Join("..", "..", "examples", "skills")
	if _, err := os.Stat(examplesDir); err != nil {
		t.Skip("examples/skills directory not found, skipping")
	}

	r := NewRegistry()

	entries, err := os.ReadDir(examplesDir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		s, err := Load(filepath.Join(examplesDir, entry.Name()))
		if err != nil {
			t.Errorf("Load(%s): %v", entry.Name(), err)
			continue
		}
		if err := r.Add(s); err != nil {
			t.Errorf("Add(%s): %v", entry.Name(), err)
		}
	}

	// Should have loaded all three example skills
	if len(r.All()) != 3 {
		t.Fatalf("loaded %d skills, want 3", len(r.All()))
	}

	// code-review should trigger on "review"
	if matched := r.Match("please review this PR"); len(matched) < 2 {
		t.Error("'review' should match code-review + safety")
	}

	// summarizer should trigger on "summarize"
	if matched := r.Match("summarize this article"); len(matched) < 2 {
		t.Error("'summarize' should match summarizer + safety")
	}

	// safety should always trigger
	if matched := r.Match("hello world"); len(matched) != 1 {
		t.Errorf("unrelated message should match only safety, got %d", len(matched))
	}

	// Summary should be lightweight
	summary := r.Summary()
	if !strings.Contains(summary, "code-review") {
		t.Error("summary should list code-review")
	}
	if !strings.Contains(summary, "summarizer") {
		t.Error("summary should list summarizer")
	}
	if !strings.Contains(summary, "safety") {
		t.Error("summary should list safety")
	}
	// Should NOT contain full instruction content
	if strings.Contains(summary, "SQL injection") {
		t.Error("summary should not contain full instruction content")
	}
}
