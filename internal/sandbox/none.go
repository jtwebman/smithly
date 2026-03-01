package sandbox

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"syscall"
	"time"
)

// NoneProvider executes code skills as local subprocesses with no isolation.
type NoneProvider struct {
	env EnvConfig
}

func (p *NoneProvider) Name() string { return "none" }

func (p *NoneProvider) Available() (ok bool, msg string) {
	return true, "subprocess execution (no sandbox)"
}

func (p *NoneProvider) Run(ctx context.Context, opts RunOpts) (*RunResult, error) {
	skill := opts.Skill
	if skill.Manifest.Skill.Type != "code" {
		return nil, fmt.Errorf("skill %q is not a code skill", skill.Manifest.Skill.Name)
	}

	cfg := skill.Manifest.Code
	if cfg == nil {
		return nil, fmt.Errorf("skill %q missing [code] section in manifest", skill.Manifest.Skill.Name)
	}

	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}

	// Build environment with sidecar, data stores, and proxy
	env, token := BuildEnv(p.env, skill.Manifest.Skill.Name, timeout, opts.Env)
	if token != "" {
		defer p.env.Sidecar.RevokeToken(token)
	}

	// Build step if configured
	if cfg.Build != "" {
		if err := build(ctx, skill.Path, cfg.Build, env); err != nil {
			return nil, fmt.Errorf("build: %w", err)
		}
	}

	// Determine command to run
	var cmd *exec.Cmd
	ctx, cancel := context.WithTimeout(ctx, timeout)
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
	if opts.Input != nil {
		cmd.Stdin = bytes.NewReader(opts.Input)
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

// build runs an optional build command before skill execution.
func build(ctx context.Context, dir, buildCmd string, env []string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-c", buildCmd)
	cmd.Dir = dir
	cmd.Env = env

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%w: %s", err, stderr.String())
	}
	return nil
}
