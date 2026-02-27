// Package sandbox provides pluggable execution environments for code skills.
// Each Provider implements a different isolation strategy: subprocess (none),
// Docker container, or Fly Machine.
package sandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"smithly.dev/internal/config"
	"smithly.dev/internal/skills"
)

// Provider executes code skills in a sandboxed environment.
type Provider interface {
	// Name returns the provider identifier ("none", "docker", "fly").
	Name() string

	// Available reports whether the provider can run skills.
	// Returns true/false and a human-readable detail string.
	Available() (bool, string)

	// Run executes a code skill and returns its output.
	Run(ctx context.Context, opts RunOpts) (*RunResult, error)
}

// RunOpts holds the parameters for a single code skill execution.
type RunOpts struct {
	Skill   *skills.Skill
	Input   json.RawMessage
	Env     []string      // base env (PATH, etc.)
	Timeout time.Duration // 0 = 30s default
}

// RunResult holds the output of a code skill execution.
type RunResult struct {
	Output   string `json:"output,omitempty"`
	Error    string `json:"error,omitempty"`
	ExitCode int    `json:"exit_code"`
}

// NewProvider creates a Provider based on the sandbox config.
func NewProvider(cfg config.SandboxConfig, sc skills.SidecarIface, stores []config.DataStoreConfig, proxyAddr string) (Provider, error) {
	ec := EnvConfig{
		Sidecar:    sc,
		DataStores: stores,
		ProxyAddr:  proxyAddr,
	}

	switch cfg.Provider {
	case "", "none":
		return &NoneProvider{env: ec}, nil
	case "docker":
		return &DockerProvider{env: ec, memory: cfg.Memory, cpus: cfg.CPUs}, nil
	case "fly":
		return &FlyProvider{}, nil
	default:
		return nil, fmt.Errorf("unknown sandbox provider: %q", cfg.Provider)
	}
}
