package skills

import (
	"fmt"
	"strings"
)

// Registry holds all installed instruction skills for an agent.
type Registry struct {
	skills map[string]*Skill // keyed by skill name
}

// NewRegistry creates an empty skill registry.
func NewRegistry() *Registry {
	return &Registry{skills: make(map[string]*Skill)}
}

// Add registers a skill. Returns an error if a skill with the same name exists.
func (r *Registry) Add(s *Skill) error {
	name := s.Manifest.Skill.Name
	if _, exists := r.skills[name]; exists {
		return fmt.Errorf("skill %q already installed", name)
	}
	r.skills[name] = s
	return nil
}

// Remove unregisters a skill by name.
func (r *Registry) Remove(name string) bool {
	if _, exists := r.skills[name]; !exists {
		return false
	}
	delete(r.skills, name)
	return true
}

// Get returns a skill by name.
func (r *Registry) Get(name string) (*Skill, bool) {
	s, ok := r.skills[name]
	return s, ok
}

// All returns all installed skills.
func (r *Registry) All() []*Skill {
	result := make([]*Skill, 0, len(r.skills))
	for _, s := range r.skills {
		result = append(result, s)
	}
	return result
}

// Match returns all skills whose triggers match the given user message.
func (r *Registry) Match(message string) []*Skill {
	var matched []*Skill
	for _, s := range r.skills {
		if s.Matches(message) {
			matched = append(matched, s)
		}
	}
	return matched
}

// Summary returns a lightweight listing of all installed skills
// (name + description only) for inclusion in the system prompt.
// The agent can use the read_skill tool to load full instructions.
func (r *Registry) Summary() string {
	if len(r.skills) == 0 {
		return ""
	}

	var lines []string
	lines = append(lines, "## Available Skills")
	lines = append(lines, "")
	lines = append(lines, "Use the `read_skill` tool to load a skill's full instructions when relevant.")
	lines = append(lines, "")

	for _, s := range r.skills {
		desc := s.Manifest.Skill.Description
		if desc == "" {
			desc = "(no description)"
		}
		triggers := formatTriggers(s.Manifest.Triggers)
		lines = append(lines, fmt.Sprintf("- **%s**: %s %s", s.Manifest.Skill.Name, desc, triggers))
	}

	return strings.Join(lines, "\n")
}

func formatTriggers(triggers []Trigger) string {
	if len(triggers) == 0 {
		return ""
	}
	var parts []string
	for _, t := range triggers {
		switch t.Type {
		case "always":
			parts = append(parts, "always active")
		case "keyword":
			parts = append(parts, fmt.Sprintf("keyword: %q", t.Pattern))
		case "regex":
			parts = append(parts, fmt.Sprintf("pattern: /%s/", t.Pattern))
		}
	}
	return "[" + strings.Join(parts, ", ") + "]"
}
