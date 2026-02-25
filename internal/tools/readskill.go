package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"smithly.dev/internal/skills"
)

// ReadSkill is a tool that lets the agent load a skill's full instructions.
// Skills are listed as lightweight summaries in the system prompt; the agent
// uses this tool to read the full content when it decides a skill is relevant.
type ReadSkill struct {
	registry *skills.Registry
}

// NewReadSkill creates a read_skill tool backed by the given skill registry.
func NewReadSkill(r *skills.Registry) *ReadSkill {
	return &ReadSkill{registry: r}
}

func (rs *ReadSkill) Name() string        { return "read_skill" }
func (rs *ReadSkill) Description() string {
	return "Load the full instructions for an installed skill by name. Use this when a skill is relevant to the user's request."
}
func (rs *ReadSkill) NeedsApproval() bool { return false }

func (rs *ReadSkill) Parameters() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"name": {
				"type": "string",
				"description": "The skill name to load"
			}
		},
		"required": ["name"]
	}`)
}

func (rs *ReadSkill) Run(_ context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("parse args: %w", err)
	}
	if params.Name == "" {
		return "", fmt.Errorf("skill name is required")
	}

	skill, ok := rs.registry.Get(params.Name)
	if !ok {
		// List available skills to help the agent
		var names []string
		for _, s := range rs.registry.All() {
			names = append(names, s.Manifest.Skill.Name)
		}
		return fmt.Sprintf("Skill %q not found. Available skills: %v", params.Name, names), nil
	}

	return skill.Content, nil
}
