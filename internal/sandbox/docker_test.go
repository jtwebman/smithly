package sandbox

import (
	"testing"

	"smithly.dev/internal/config"
	"smithly.dev/internal/skills"
)

func TestDockerRuntimeImage(t *testing.T) {
	tests := []struct {
		runtime string
		want    string
	}{
		{"python3", "python:3.12-slim"},
		{"node", "node:22-slim"},
		{"bash", "bash:5"},
		{"go", "golang:1.23-alpine"},
		{"bun", "oven/bun:slim"},
		{"ruby", ""},
		{"", ""},
	}

	for _, tt := range tests {
		got := runtimeImage(tt.runtime)
		if got != tt.want {
			t.Errorf("runtimeImage(%q) = %q, want %q", tt.runtime, got, tt.want)
		}
	}
}

func TestDockerRewriteSidecarURL(t *testing.T) {
	env := []string{
		"PATH=/usr/bin",
		"SMITHLY_API=http://127.0.0.1:18791",
		"SMITHLY_TOKEN=tok123",
	}

	rewritten := rewriteSidecarURL(env)

	if rewritten[0] != "PATH=/usr/bin" {
		t.Errorf("PATH should be unchanged, got %q", rewritten[0])
	}
	if rewritten[1] != "SMITHLY_API=http://host.docker.internal:18791" {
		t.Errorf("SMITHLY_API not rewritten: %q", rewritten[1])
	}
	if rewritten[2] != "SMITHLY_TOKEN=tok123" {
		t.Errorf("token should be unchanged, got %q", rewritten[2])
	}
}

func TestDockerRewriteLocalhost(t *testing.T) {
	env := []string{"SMITHLY_API=http://localhost:18791"}
	rewritten := rewriteSidecarURL(env)
	if rewritten[0] != "SMITHLY_API=http://host.docker.internal:18791" {
		t.Errorf("localhost not rewritten: %q", rewritten[0])
	}
}

func TestDockerName(t *testing.T) {
	p := &DockerProvider{}
	if p.Name() != "docker" {
		t.Errorf("name = %q, want %q", p.Name(), "docker")
	}
}

func TestDockerBuildRunArgs(t *testing.T) {
	p := &DockerProvider{
		env:    EnvConfig{ProxyAddr: "127.0.0.1:18792"},
		memory: "512m",
		cpus:   "2",
	}

	cfg := &skills.CodeSkillConfig{
		Runtime:    "python3",
		Entrypoint: "main.py",
	}

	args := p.buildRunArgs("/skills/test", "python:3.12-slim", []string{"FOO=bar"}, cfg)

	assertContains(t, args, "run")
	assertContains(t, args, "--rm")
	assertContains(t, args, "--read-only")
	assertContains(t, args, "512m")
	assertContains(t, args, "2")
	assertContains(t, args, "--network")
	assertContains(t, args, "bridge") // proxy configured, so bridge
	assertContains(t, args, "host.docker.internal:host-gateway")
	assertContains(t, args, "python:3.12-slim")
	assertContains(t, args, "python3")
	assertContains(t, args, "main.py")
	assertContains(t, args, "FOO=bar")
}

func TestDockerBuildRunArgsNetworkNone(t *testing.T) {
	p := &DockerProvider{env: EnvConfig{}}

	cfg := &skills.CodeSkillConfig{
		Runtime:    "bash",
		Entrypoint: "main.sh",
	}

	args := p.buildRunArgs("/skills/test", "bash:5", nil, cfg)
	assertContains(t, args, "none") // no proxy, no sidecar => network none
}

func TestDockerBuildRunArgsDefaultLimits(t *testing.T) {
	p := &DockerProvider{env: EnvConfig{}}

	cfg := &skills.CodeSkillConfig{Runtime: "bash", Entrypoint: "main.sh"}
	args := p.buildRunArgs("/skills/test", "bash:5", nil, cfg)

	assertContains(t, args, "256m") // default memory
	assertContains(t, args, "1")    // default cpus
}

func TestDockerBuildRunArgsSQLiteMount(t *testing.T) {
	p := &DockerProvider{
		env: EnvConfig{
			DataStores: []config.DataStoreConfig{
				{Type: "sqlite", Path: "/data/store.db"},
			},
		},
	}

	cfg := &skills.CodeSkillConfig{Runtime: "bash", Entrypoint: "main.sh"}
	args := p.buildRunArgs("/skills/test", "bash:5", nil, cfg)

	// Should mount the sqlite file
	found := false
	for _, a := range args {
		if a == "/data/store.db:/data/store.db:rw" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected SQLite mount in args: %v", args)
	}
}

func assertContains(t *testing.T, slice []string, want string) {
	t.Helper()
	for _, s := range slice {
		if s == want {
			return
		}
	}
	t.Errorf("slice missing %q", want)
}
