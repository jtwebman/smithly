package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"smithly.dev/internal/config"
)

func TestWriteAndLoad(t *testing.T) {
	dir := t.TempDir()

	agent := config.AgentConfig{
		ID:        "test-bot",
		Model:     "gpt-4o",
		Workspace: "workspaces/test-bot/",
		Provider:  "openai",
		APIKey:    "sk-test-123",
		BaseURL:   "https://api.openai.com/v1",
	}

	search := config.SearchConfig{Provider: "brave", APIKey: "test-brave-key"}
	if err := config.WriteDefault(dir, agent, search); err != nil {
		t.Fatalf("WriteDefault: %v", err)
	}

	path := filepath.Join(dir, "smithly.toml")
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Gateway.Bind != "127.0.0.1" {
		t.Errorf("Bind = %q, want %q", cfg.Gateway.Bind, "127.0.0.1")
	}
	if cfg.Gateway.Port != 18789 {
		t.Errorf("Port = %d, want %d", cfg.Gateway.Port, 18789)
	}
	if cfg.Gateway.Token == "" {
		t.Error("Token should be auto-generated")
	}
	if cfg.Sandbox.Provider != "none" {
		t.Errorf("Provider = %q, want %q", cfg.Sandbox.Provider, "none")
	}
	if len(cfg.Agents) != 1 {
		t.Fatalf("Agents len = %d, want 1", len(cfg.Agents))
	}
	if cfg.Agents[0].ID != "test-bot" {
		t.Errorf("Agent ID = %q, want %q", cfg.Agents[0].ID, "test-bot")
	}
	if cfg.Agents[0].Model != "gpt-4o" {
		t.Errorf("Agent Model = %q, want %q", cfg.Agents[0].Model, "gpt-4o")
	}
	if cfg.Agents[0].APIKey != "sk-test-123" {
		t.Errorf("Agent APIKey = %q, want %q", cfg.Agents[0].APIKey, "sk-test-123")
	}
}

func TestDefaultConfig(t *testing.T) {
	cfg := config.DefaultConfig()

	if cfg.Gateway.Bind != "127.0.0.1" {
		t.Errorf("Bind = %q, want %q", cfg.Gateway.Bind, "127.0.0.1")
	}
	if cfg.Gateway.Port != 18789 {
		t.Errorf("Port = %d, want %d", cfg.Gateway.Port, 18789)
	}
	if cfg.Storage.Database != "smithly.db" {
		t.Errorf("Database = %q, want %q", cfg.Storage.Database, "smithly.db")
	}
}

func TestLoadMissing(t *testing.T) {
	_, err := config.Load("/nonexistent/path/smithly.toml")
	if err == nil {
		t.Fatal("expected error loading nonexistent config")
	}
}

func TestMultipleAgents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "smithly.toml")

	content := `
[gateway]
bind = "127.0.0.1"
port = 18789
token = "test-token"

[sandbox]
provider = "docker"

[storage]
database = "smithly.db"
files_dir = "data/skills/"

[[agents]]
id = "assistant"
model = "gpt-4o"
workspace = "workspaces/assistant/"
api_key = "sk-111"

[[agents]]
id = "codebot"
model = "claude-sonnet-4-5"
workspace = "workspaces/codebot/"
provider = "anthropic"
api_key = "sk-ant-222"
base_url = "https://api.anthropic.com/v1"
`
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.Agents) != 2 {
		t.Fatalf("Agents len = %d, want 2", len(cfg.Agents))
	}
	if cfg.Agents[0].ID != "assistant" {
		t.Errorf("first agent = %q, want %q", cfg.Agents[0].ID, "assistant")
	}
	if cfg.Agents[1].ID != "codebot" {
		t.Errorf("second agent = %q, want %q", cfg.Agents[1].ID, "codebot")
	}
	if cfg.Sandbox.Provider != "docker" {
		t.Errorf("Provider = %q, want %q", cfg.Sandbox.Provider, "docker")
	}
}

func TestTokenAutoGenAndPersist(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "smithly.toml")

	// Config without token — should auto-generate and persist
	content := `[gateway]
bind = "127.0.0.1"
port = 18789

[sandbox]
provider = "none"

[storage]
database = "smithly.db"

[[agents]]
id = "bot"
model = "gpt-4o"
workspace = "workspaces/bot/"
api_key = "sk-test"
`
	os.WriteFile(path, []byte(content), 0644)

	cfg1, err := config.Load(path)
	if err != nil {
		t.Fatalf("first Load: %v", err)
	}
	if cfg1.Gateway.Token == "" {
		t.Fatal("token should be auto-generated")
	}

	// Load again — token should be persisted and match
	cfg2, err := config.Load(path)
	if err != nil {
		t.Fatalf("second Load: %v", err)
	}
	if cfg2.Gateway.Token != cfg1.Gateway.Token {
		t.Errorf("token changed: first=%q, second=%q", cfg1.Gateway.Token, cfg2.Gateway.Token)
	}

	// Verify other config wasn't corrupted
	if cfg2.Gateway.Port != 18789 {
		t.Errorf("Port = %d after token persist", cfg2.Gateway.Port)
	}
	if len(cfg2.Agents) != 1 || cfg2.Agents[0].ID != "bot" {
		t.Errorf("Agents corrupted after token persist")
	}
}

func TestOllamaConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "smithly.toml")

	content := `
[gateway]
bind = "127.0.0.1"
port = 18789
token = "test"

[sandbox]
provider = "none"

[storage]
database = "smithly.db"

[[agents]]
id = "local"
model = "llama3.2"
workspace = "workspaces/local/"
provider = "ollama"
base_url = "http://localhost:11434/v1"
`
	os.WriteFile(path, []byte(content), 0644)

	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Agents[0].BaseURL != "http://localhost:11434/v1" {
		t.Errorf("BaseURL = %q", cfg.Agents[0].BaseURL)
	}
	if cfg.Agents[0].Provider != "ollama" {
		t.Errorf("Provider = %q", cfg.Agents[0].Provider)
	}
}
