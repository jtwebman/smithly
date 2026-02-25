package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"
)

// ClaudeCode delegates complex coding tasks to Claude Code (the Anthropic CLI).
// Users with a Claude Max plan or API key can use this for heavy-duty
// code generation, refactoring, debugging, and file editing.
type ClaudeCode struct{}

func NewClaudeCode() *ClaudeCode { return &ClaudeCode{} }

func (c *ClaudeCode) Name() string { return "claude_code" }
func (c *ClaudeCode) Description() string {
	return "Delegate a complex coding task to Claude Code (Anthropic CLI). Use this for code generation, refactoring, debugging, file editing, and multi-file changes. The user must have Claude Code installed and authenticated."
}
func (c *ClaudeCode) NeedsApproval() bool { return true }

func (c *ClaudeCode) Parameters() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"prompt": {
				"type": "string",
				"description": "The task to give to Claude Code. Be specific about what files to modify and what changes to make."
			},
			"working_directory": {
				"type": "string",
				"description": "The directory to run Claude Code in. Defaults to current directory."
			}
		},
		"required": ["prompt"]
	}`)
}

func (c *ClaudeCode) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Prompt           string `json:"prompt"`
		WorkingDirectory string `json:"working_directory"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("parse args: %w", err)
	}
	if params.Prompt == "" {
		return "", fmt.Errorf("prompt is required")
	}

	// Check if claude is installed
	claudePath, err := exec.LookPath("claude")
	if err != nil {
		return "Claude Code is not installed. Install it with: npm install -g @anthropic-ai/claude-code", nil
	}

	// 5 minute timeout for coding tasks
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, claudePath, "--print", "--dangerously-skip-permissions", params.Prompt)

	if params.WorkingDirectory != "" {
		cmd.Dir = params.WorkingDirectory
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err = cmd.Run()

	result := stdout.String()
	if stderr.Len() > 0 {
		result += "\nstderr: " + stderr.String()
	}
	if err != nil {
		result += "\nexit: " + err.Error()
	}

	if result == "" {
		result = "(no output)"
	}

	// Truncate large output
	if len(result) > 100000 {
		result = result[:100000] + "\n\n[truncated]"
	}

	return result, nil
}
