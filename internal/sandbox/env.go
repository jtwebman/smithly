package sandbox

import (
	"time"

	"smithly.dev/internal/config"
	"smithly.dev/internal/skills"
)

// EnvConfig holds the dependencies needed to build skill environment variables.
type EnvConfig struct {
	Sidecar    skills.SidecarIface
	DataStores []config.DataStoreConfig
	ProxyAddr  string
}

// BuildEnv constructs environment variables for a code skill execution.
// Delegates to skills.BuildEnv — this wrapper exists so sandbox providers
// can pass their EnvConfig without importing skills directly.
func BuildEnv(ec EnvConfig, skillName string, timeout time.Duration, base []string) (env []string, token string) {
	return skills.BuildEnv(ec.Sidecar, ec.DataStores, ec.ProxyAddr, skillName, timeout, base)
}
