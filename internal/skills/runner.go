package skills

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"syscall"
	"time"
)

// CodeSkillConfig is the manifest section for code skills.
type CodeSkillConfig struct {
	Runtime    string `toml:"runtime"`    // "python3", "bash", "node", "bun", "go"
	Entrypoint string `toml:"entrypoint"` // "main.py", "./skill", etc.
	Build      string `toml:"build"`      // optional build command ("go build -o skill .")
}

// RunResult holds the output of a code skill execution.
type RunResult struct {
	Output   string `json:"output,omitempty"`
	Error    string `json:"error,omitempty"`
	ExitCode int    `json:"exit_code"`
}

// Runner executes code skills as subprocesses.
type Runner struct {
	timeout time.Duration
}

// NewRunner creates a code skill runner with the given execution timeout.
func NewRunner(timeout time.Duration) *Runner {
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	return &Runner{timeout: timeout}
}

// Run executes a code skill with JSON input on stdin and captures JSON output on stdout.
// env is a list of "KEY=VALUE" strings for environment variables (OAuth2 tokens, notify URL, etc.)
func (r *Runner) Run(ctx context.Context, skill *Skill, input json.RawMessage, env []string) (*RunResult, error) {
	if skill.Manifest.Skill.Type != "code" {
		return nil, fmt.Errorf("skill %q is not a code skill", skill.Manifest.Skill.Name)
	}

	cfg := skill.Manifest.Code
	if cfg == nil {
		return nil, fmt.Errorf("skill %q missing [code] section in manifest", skill.Manifest.Skill.Name)
	}

	// Build step if configured
	if cfg.Build != "" {
		if err := r.build(ctx, skill.Path, cfg.Build, env); err != nil {
			return nil, fmt.Errorf("build: %w", err)
		}
	}

	// Determine command to run
	var cmd *exec.Cmd
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	if cfg.Runtime != "" {
		cmd = exec.CommandContext(ctx, cfg.Runtime, cfg.Entrypoint)
	} else {
		cmd = exec.CommandContext(ctx, cfg.Entrypoint)
	}

	cmd.Dir = skill.Path
	cmd.Env = env
	// Create a new process group so we can kill all child processes on timeout
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}

	// Pass input on stdin
	if input != nil {
		cmd.Stdin = bytes.NewReader(input)
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	result := &RunResult{
		Output: stdout.String(),
	}

	if stderr.Len() > 0 {
		result.Error = stderr.String()
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			return nil, fmt.Errorf("run skill: %w", err)
		}
	}

	return result, nil
}

// build runs the build command for a compiled code skill.
func (r *Runner) build(ctx context.Context, dir, buildCmd string, env []string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-c", buildCmd)
	cmd.Dir = dir
	cmd.Env = env

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %s", err, stderr.String())
	}
	return nil
}
