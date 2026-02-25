package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Bash runs shell commands. Requires user approval.
type Bash struct{}

func NewBash() *Bash { return &Bash{} }

func (b *Bash) Name() string        { return "bash" }
func (b *Bash) Description() string { return "Run a bash command and return its output. Use for system operations, git, package managers, etc." }
func (b *Bash) NeedsApproval() bool { return true }

func (b *Bash) Parameters() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"command": {
				"type": "string",
				"description": "The bash command to execute"
			}
		},
		"required": ["command"]
	}`)
}

func (b *Bash) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Command string `json:"command"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("parse args: %w", err)
	}
	if params.Command == "" {
		return "", fmt.Errorf("command is required")
	}

	// 30 second timeout
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-c", params.Command)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	var out strings.Builder
	if stdout.Len() > 0 {
		out.WriteString(stdout.String())
	}
	if stderr.Len() > 0 {
		if out.Len() > 0 {
			out.WriteString("\n")
		}
		fmt.Fprintf(&out, "stderr: %s", stderr.String())
	}
	if err != nil {
		if out.Len() > 0 {
			out.WriteString("\n")
		}
		fmt.Fprintf(&out, "exit: %v", err)
	}

	result := out.String()
	// Truncate large output
	if len(result) > 50000 {
		result = result[:50000] + "\n\n[truncated]"
	}
	if result == "" {
		result = "(no output)"
	}
	return result, nil
}
