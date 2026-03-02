package workspace_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"smithly.dev/internal/workspace"
)

func TestLoadFullWorkspace(t *testing.T) {
	dir := t.TempDir()

	os.WriteFile(filepath.Join(dir, "SOUL.md"), []byte("Be thoughtful and kind."), 0644)
	os.WriteFile(filepath.Join(dir, "USER.md"), []byte("The user prefers short answers."), 0644)
	os.WriteFile(filepath.Join(dir, "INSTRUCTIONS.md"), []byte("Always respond in English."), 0644)
	os.WriteFile(filepath.Join(dir, "IDENTITY.toml"), []byte("name = \"Atlas\"\nemoji = \"🌎\"\n"), 0644)

	ws, err := workspace.Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if ws.Soul != "Be thoughtful and kind." {
		t.Errorf("Soul = %q", ws.Soul)
	}
	if ws.User != "The user prefers short answers." {
		t.Errorf("User = %q", ws.User)
	}
	if ws.Instructions != "Always respond in English." {
		t.Errorf("Instructions = %q", ws.Instructions)
	}
	if ws.Identity.Name != "Atlas" {
		t.Errorf("Identity.Name = %q", ws.Identity.Name)
	}
	if ws.Identity.Emoji != "🌎" {
		t.Errorf("Identity.Emoji = %q", ws.Identity.Emoji)
	}
}

func TestLoadEmptyWorkspace(t *testing.T) {
	dir := t.TempDir()

	ws, err := workspace.Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	prompt := ws.SystemPrompt()
	if prompt != "You are a helpful AI assistant." {
		t.Errorf("empty workspace prompt = %q", prompt)
	}
}

func TestSystemPromptAssembly(t *testing.T) {
	dir := t.TempDir()

	os.WriteFile(filepath.Join(dir, "SOUL.md"), []byte("Be direct."), 0644)
	os.WriteFile(filepath.Join(dir, "IDENTITY.toml"), []byte("name = \"Helper\"\n"), 0644)
	os.WriteFile(filepath.Join(dir, "INSTRUCTIONS.md"), []byte("Use bullet points."), 0644)

	ws, err := workspace.Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	prompt := ws.SystemPrompt()

	if !strings.Contains(prompt, "## Soul") {
		t.Error("missing Soul section")
	}
	if !strings.Contains(prompt, "Be direct.") {
		t.Error("missing soul content")
	}
	if !strings.Contains(prompt, "## Identity") {
		t.Error("missing Identity section")
	}
	if !strings.Contains(prompt, "Name: Helper") {
		t.Error("missing identity name")
	}
	if !strings.Contains(prompt, "## Instructions") {
		t.Error("missing Instructions section")
	}
	if !strings.Contains(prompt, "Use bullet points.") {
		t.Error("missing instructions content")
	}
}

func TestPartialWorkspace(t *testing.T) {
	dir := t.TempDir()

	// Only SOUL.md — everything else is missing
	os.WriteFile(filepath.Join(dir, "SOUL.md"), []byte("Just be nice."), 0644)

	ws, err := workspace.Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	prompt := ws.SystemPrompt()
	if !strings.Contains(prompt, "Just be nice.") {
		t.Errorf("prompt = %q", prompt)
	}
	// Should not contain sections for missing files
	if strings.Contains(prompt, "## User") {
		t.Error("should not have User section")
	}
}

func TestLoadBootAndHeartbeat(t *testing.T) {
	dir := t.TempDir()

	os.WriteFile(filepath.Join(dir, "BOOT.md"), []byte("Welcome, I'm ready to help."), 0644)
	os.WriteFile(filepath.Join(dir, "HEARTBEAT.md"), []byte("Still here, anything else?"), 0644)

	ws, err := workspace.Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if ws.Boot != "Welcome, I'm ready to help." {
		t.Errorf("Boot = %q", ws.Boot)
	}
	if ws.Heartbeat != "Still here, anything else?" {
		t.Errorf("Heartbeat = %q", ws.Heartbeat)
	}
}

func TestLoadMalformedIdentity(t *testing.T) {
	dir := t.TempDir()

	os.WriteFile(filepath.Join(dir, "IDENTITY.toml"), []byte("invalid = [[["), 0644)

	_, err := workspace.Load(dir)
	if err == nil {
		t.Fatal("expected error for malformed IDENTITY.toml, got nil")
	}
	if !strings.Contains(err.Error(), "parse") {
		t.Errorf("error = %q, want it to mention 'parse'", err)
	}
}

func TestLoadAvatarField(t *testing.T) {
	dir := t.TempDir()

	os.WriteFile(filepath.Join(dir, "IDENTITY.toml"), []byte("avatar = \"bot.png\"\n"), 0644)

	ws, err := workspace.Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if ws.Identity.Avatar != "bot.png" {
		t.Errorf("Identity.Avatar = %q, want %q", ws.Identity.Avatar, "bot.png")
	}
}
