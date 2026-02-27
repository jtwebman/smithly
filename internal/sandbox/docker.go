package sandbox

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"smithly.dev/internal/skills"
)

// DockerProvider executes code skills in ephemeral Docker containers.
type DockerProvider struct {
	env    EnvConfig
	memory string // e.g. "256m"
	cpus   string // e.g. "1"
}

func (p *DockerProvider) Name() string { return "docker" }

// CheckDocker reports whether Docker is available for use.
func CheckDocker() (bool, string) {
	return (&DockerProvider{}).Available()
}

func (p *DockerProvider) Available() (bool, string) {
	path, err := exec.LookPath("docker")
	if err != nil {
		return false, "docker not found in PATH"
	}

	// Check that the daemon is reachable
	cmd := exec.Command(path, "info")
	if err := cmd.Run(); err != nil {
		return false, "docker daemon not reachable"
	}

	return true, "docker available"
}

func (p *DockerProvider) Run(ctx context.Context, opts RunOpts) (*RunResult, error) {
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

	image := runtimeImage(cfg.Runtime)
	if image == "" {
		return nil, fmt.Errorf("no Docker image for runtime %q", cfg.Runtime)
	}

	// Build environment with sidecar, data stores, and proxy
	env, token := BuildEnv(p.env, skill.Manifest.Skill.Name, timeout, opts.Env)
	if token != "" {
		defer p.env.Sidecar.RevokeToken(token)
	}

	// Rewrite sidecar URL for container networking
	env = rewriteSidecarURL(env)

	skillPath, err := filepath.Abs(skill.Path)
	if err != nil {
		return nil, fmt.Errorf("resolve skill path: %w", err)
	}

	// Build step if configured — mount skill code read-write so build artifacts persist
	if cfg.Build != "" {
		if err := p.dockerBuild(ctx, skillPath, cfg.Build, image, env); err != nil {
			return nil, fmt.Errorf("build: %w", err)
		}
	}

	// Construct docker run args
	args := p.buildRunArgs(skillPath, image, env, cfg)

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "docker", args...)

	// Pass input on stdin
	if opts.Input != nil {
		cmd.Stdin = bytes.NewReader(opts.Input)
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()

	result := &RunResult{
		Output: stdout.String(),
	}

	if stderr.Len() > 0 {
		result.Error = stderr.String()
	}

	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			return nil, fmt.Errorf("run skill: %w", runErr)
		}
	}

	return result, nil
}

// buildRunArgs constructs the docker run command arguments.
func (p *DockerProvider) buildRunArgs(skillPath, image string, env []string, cfg *skills.CodeSkillConfig) []string {
	args := []string{
		"run", "--rm",
		"-i",
		"--read-only",
		"--tmpfs", "/tmp:rw,size=64m",
		"-v", skillPath + ":/skill:ro",
		"-w", "/skill",
	}

	// Resource limits
	memory := p.memory
	if memory == "" {
		memory = "256m"
	}
	cpus := p.cpus
	if cpus == "" {
		cpus = "1"
	}
	args = append(args, "--memory", memory, "--cpus", cpus)

	// Network: no network by default, bridge if proxy/sidecar configured
	if p.env.ProxyAddr != "" || p.env.Sidecar != nil {
		args = append(args, "--network", "bridge")
		args = append(args, "--add-host", "host.docker.internal:host-gateway")
	} else {
		args = append(args, "--network", "none")
	}

	// Mount SQLite data store paths
	for _, ds := range p.env.DataStores {
		if ds.Type == "sqlite" && ds.Path != "" {
			absPath, err := filepath.Abs(ds.Path)
			if err == nil {
				args = append(args, "-v", absPath+":"+absPath+":rw")
			}
		}
	}

	// Environment variables
	for _, e := range env {
		args = append(args, "-e", e)
	}

	// Image and command
	args = append(args, image)
	if cfg.Runtime != "" {
		args = append(args, cfg.Runtime, cfg.Entrypoint)
	} else {
		args = append(args, cfg.Entrypoint)
	}

	return args
}

// dockerBuild runs a build command inside a container with read-write skill mount.
func (p *DockerProvider) dockerBuild(ctx context.Context, skillPath, buildCmd, image string, env []string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	args := []string{
		"run", "--rm",
		"-v", skillPath + ":/skill:rw",
		"-w", "/skill",
	}

	for _, e := range env {
		args = append(args, "-e", e)
	}

	args = append(args, image, "bash", "-c", buildCmd)

	cmd := exec.CommandContext(ctx, "docker", args...)

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %s", err, stderr.String())
	}
	return nil
}

// runtimeImage maps a skill runtime to a Docker image.
func runtimeImage(runtime string) string {
	switch runtime {
	case "python3":
		return "python:3.12-slim"
	case "node":
		return "node:22-slim"
	case "bash":
		return "bash:5"
	case "go":
		return "golang:1.23-alpine"
	case "bun":
		return "oven/bun:slim"
	default:
		return ""
	}
}

// rewriteSidecarURL replaces 127.0.0.1 with host.docker.internal in SMITHLY_API
// so the container can reach the host's sidecar.
func rewriteSidecarURL(env []string) []string {
	out := make([]string, len(env))
	for i, e := range env {
		if strings.HasPrefix(e, "SMITHLY_API=") {
			e = strings.Replace(e, "127.0.0.1", "host.docker.internal", 1)
			e = strings.Replace(e, "localhost", "host.docker.internal", 1)
		}
		out[i] = e
	}
	return out
}
