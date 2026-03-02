package main

import (
	"bufio"
	"fmt"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"smithly.dev/internal/config"
)

// cmdInit runs the first-time setup wizard.
func cmdInit() {
	dir, _ := os.Getwd()
	configPath := filepath.Join(dir, "smithly.toml")

	if _, err := os.Stat(configPath); err == nil {
		fmt.Println("smithly.toml already exists. Delete it to re-initialize.")
		return
	}

	reader := bufio.NewReader(os.Stdin)

	fmt.Println("Welcome to Smithly!")
	fmt.Println()

	// Agent name
	fmt.Print("Agent name [assistant]: ")
	agentName, _ := reader.ReadString('\n')
	agentName = strings.TrimSpace(agentName)
	if agentName == "" {
		agentName = "assistant"
	}

	provider, baseURL, model, apiKey := promptLLMConfig(reader)

	// Search provider (Brave API key)
	fmt.Print("\nBrave Search API key (free at https://brave.com/search/api/, or press Enter to skip): ")
	braveKey, _ := reader.ReadString('\n')
	braveKey = strings.TrimSpace(braveKey)

	// Create workspace directory
	wsPath := filepath.Join("workspaces", agentName)
	if err := os.MkdirAll(filepath.Join(dir, wsPath), 0o755); err != nil {
		log.Fatalf("Failed to create workspace directory: %v", err)
	}

	// Write default workspace files
	writeIfMissing(filepath.Join(dir, wsPath, "SOUL.md"),
		"You are a helpful, thoughtful AI assistant. You communicate clearly and concisely.")
	writeIfMissing(filepath.Join(dir, wsPath, "IDENTITY.toml"),
		fmt.Sprintf("name = %q\nemoji = \"🤖\"\n", agentName))

	// Write config
	agentCfg := config.AgentConfig{
		ID:        agentName,
		Model:     model,
		Workspace: wsPath,
		Provider:  provider,
		APIKey:    apiKey,
		BaseURL:   baseURL,
	}
	searchCfg := config.SearchConfig{Provider: "brave", APIKey: braveKey}
	if err := config.WriteDefault(dir, agentCfg, searchCfg); err != nil {
		log.Fatalf("Failed to write config: %v", err)
	}

	fmt.Println()
	fmt.Println("Setup complete! Created:")
	fmt.Printf("  smithly.toml\n")
	fmt.Printf("  %s/SOUL.md\n", wsPath)
	fmt.Printf("  %s/IDENTITY.toml\n", wsPath)
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  smithly chat    — start chatting with your agent")
	fmt.Println("  smithly start   — start the HTTP gateway")
}

// promptLLMConfig runs the interactive LLM provider/model/key prompts.
func promptLLMConfig(reader *bufio.Reader) (provider, baseURL, model, apiKey string) {
	fmt.Println("\nLLM Provider:")
	fmt.Println("  1. OpenAI")
	fmt.Println("  2. Anthropic (via OpenAI-compatible)")
	fmt.Println("  3. OpenRouter")
	fmt.Println("  4. Ollama (local)")
	fmt.Print("Choice [1]: ")
	choice, _ := reader.ReadString('\n')
	choice = strings.TrimSpace(choice)

	switch choice {
	case "2":
		baseURL = "https://api.anthropic.com/v1"
		provider = "anthropic"
	case "3":
		baseURL = "https://openrouter.ai/api/v1"
		provider = "openrouter"
	case "4":
		baseURL = "http://localhost:11434/v1"
		provider = "ollama"
	default:
		baseURL = "https://api.openai.com/v1"
		provider = "openai"
	}

	var defaultModel string
	switch provider {
	case "anthropic":
		defaultModel = "claude-sonnet-4-6-20250514"
	case "ollama":
		defaultModel = "llama3.2"
	default:
		defaultModel = "gpt-4o"
	}
	fmt.Printf("\nModel [%s]: ", defaultModel)
	model, _ = reader.ReadString('\n')
	model = strings.TrimSpace(model)
	if model == "" {
		model = defaultModel
	}

	if provider != "ollama" {
		fmt.Print("\nAPI key: ")
		apiKey, _ = reader.ReadString('\n')
		apiKey = strings.TrimSpace(apiKey)
	}
	return
}

func writeIfMissing(path, content string) {
	if _, err := os.Stat(path); err == nil {
		return
	}
	if err := os.WriteFile(path, []byte(content+"\n"), 0o644); err != nil {
		slog.Warn("failed to write file", "path", path, "err", err)
	}
}
