package sandbox

import (
	"strings"
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
// It injects sidecar credentials, data store connection info, and proxy settings.
// Returns the augmented env slice and the issued sidecar token (empty if no sidecar).
// The caller must defer RevokeToken on the returned token if non-empty.
func BuildEnv(ec EnvConfig, skillName string, timeout time.Duration, base []string) (env []string, token string) {
	env = append(env, base...)

	// Sidecar credentials
	if ec.Sidecar != nil {
		token = ec.Sidecar.IssueToken(skillName, timeout+30*time.Second)
		env = append(env,
			"SMITHLY_API="+ec.Sidecar.URL(),
			"SMITHLY_TOKEN="+token,
		)
	}

	// Data store connection info
	dbTypeSet := false
	for _, ds := range ec.DataStores {
		prefix := "SMITHLY_" + strings.ToUpper(ds.Type)
		switch ds.Type {
		case "sqlite":
			env = append(env, prefix+"_PATH="+ds.Path)
		default:
			env = append(env, prefix+"_URL="+ds.URL)
		}
		if !dbTypeSet {
			env = append(env, "SMITHLY_DB_TYPE="+ds.Type)
			dbTypeSet = true
		}
	}

	// Proxy for outbound network gating
	if ec.ProxyAddr != "" {
		proxyURL := "http://" + ec.ProxyAddr
		env = append(env,
			"HTTP_PROXY="+proxyURL,
			"HTTPS_PROXY="+proxyURL,
			"http_proxy="+proxyURL,
			"https_proxy="+proxyURL,
		)
	}

	return env, token
}
