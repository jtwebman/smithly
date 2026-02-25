package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

type Config struct {
	Gateway GatewayConfig `toml:"gateway"`
	Sandbox SandboxConfig `toml:"sandbox"`
	Storage StorageConfig `toml:"storage"`
	Search  SearchConfig  `toml:"search"`
	Agents  []AgentConfig `toml:"agents"`
}


type GatewayConfig struct {
	Bind         string `toml:"bind"`
	Port         int    `toml:"port"`
	Token        string `toml:"token"`
	RateLimit    int    `toml:"rate_limit"`    // Max requests per minute per IP (0 = unlimited)
}

type SandboxConfig struct {
	Provider string `toml:"provider"`
}

type StorageConfig struct {
	Database string `toml:"database"`
	FilesDir string `toml:"files_dir"`
}

type AgentConfig struct {
	ID        string          `toml:"id"`
	Model     string          `toml:"model"`
	Workspace string          `toml:"workspace"`
	Provider  string          `toml:"provider"`
	APIKey    string          `toml:"api_key"`
	BaseURL   string          `toml:"base_url"`
	Heartbeat *HeartbeatConfig `toml:"heartbeat"`
}

type HeartbeatConfig struct {
	Enabled    bool   `toml:"enabled"`
	Interval   string `toml:"interval"`
	QuietHours string `toml:"quiet_hours"`
}

type SearchConfig struct {
	Provider string `toml:"provider"` // "brave" (default), "duckduckgo"
	APIKey   string `toml:"api_key"`  // Brave Search API key
}

func DefaultConfig() Config {
	return Config{
		Gateway: GatewayConfig{
			Bind:      "127.0.0.1",
			Port:      18789,
			RateLimit: 60,
		},
		Sandbox: SandboxConfig{
			Provider: "none",
		},
		Storage: StorageConfig{
			Database: "smithly.db",
			FilesDir: "data/skills/",
		},
		Search: SearchConfig{
			Provider: "brave",
		},
	}
}

func Load(path string) (*Config, error) {
	cfg := DefaultConfig()

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}

	if _, err := toml.Decode(string(data), &cfg); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}

	// Generate token if not set
	if cfg.Gateway.Token == "" {
		token, err := generateToken()
		if err != nil {
			return nil, fmt.Errorf("generating token: %w", err)
		}
		cfg.Gateway.Token = token
		// Write token back to config file
		if err := appendToken(path, token); err != nil {
			return nil, fmt.Errorf("saving token: %w", err)
		}
	}

	return &cfg, nil
}

// WriteDefault writes a default smithly.toml for first-run setup.
func WriteDefault(dir string, agent AgentConfig, search SearchConfig) error {
	path := filepath.Join(dir, "smithly.toml")

	token, err := generateToken()
	if err != nil {
		return err
	}

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	fmt.Fprintf(f, `[gateway]
bind = "127.0.0.1"
port = 18789
token = %q
rate_limit = 60  # max requests per minute per IP, 0 = unlimited

[sandbox]
provider = "none"

[storage]
database = "smithly.db"
files_dir = "data/skills/"

[search]
provider = %q
`, token, search.Provider)

	if search.APIKey != "" {
		fmt.Fprintf(f, "api_key = %q\n", search.APIKey)
	}

	fmt.Fprintf(f, `
[[agents]]
id = %q
model = %q
workspace = %q
`, agent.ID, agent.Model, agent.Workspace)

	if agent.Provider != "" {
		fmt.Fprintf(f, "provider = %q\n", agent.Provider)
	}
	if agent.APIKey != "" {
		fmt.Fprintf(f, "api_key = %q\n", agent.APIKey)
	}
	if agent.BaseURL != "" {
		fmt.Fprintf(f, "base_url = %q\n", agent.BaseURL)
	}

	return nil
}

func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func appendToken(path, token string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	content := string(data)
	// Insert token after [gateway] section header
	marker := "[gateway]\n"
	idx := strings.Index(content, marker)
	if idx >= 0 {
		insert := idx + len(marker)
		content = content[:insert] + fmt.Sprintf("token = %q\n", token) + content[insert:]
	} else {
		// No [gateway] section found — append one
		content = content + fmt.Sprintf("\n[gateway]\ntoken = %q\n", token)
	}
	return os.WriteFile(path, []byte(content), 0600)
}
