package main

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"smithly.dev/internal/config"
)

// cmdAgent manages agents (list, add, remove).
func cmdAgent() {
	if len(os.Args) < 3 {
		fmt.Println(`Usage: smithly agent <subcommand>

Subcommands:
  list      List all configured agents
  add       Add a new agent (interactive)
  remove    Remove an agent by ID`)
		return
	}

	switch os.Args[2] {
	case "list":
		cmdAgentList()
	case "add":
		cmdAgentAdd()
	case "remove":
		cmdAgentRemove()
	default:
		fmt.Fprintf(os.Stderr, "unknown agent subcommand: %s\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdAgentList() {
	cfg, err := config.Load("smithly.toml")
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	if len(cfg.Agents) == 0 {
		fmt.Println("No agents configured.")
		return
	}

	fmt.Printf("%-20s %-25s %-12s %s\n", "ID", "MODEL", "PROVIDER", "WORKSPACE")
	for _, a := range cfg.Agents {
		provider := a.Provider
		if provider == "" {
			provider = "openai"
		}
		toolInfo := ""
		if len(a.Tools) > 0 {
			toolInfo = fmt.Sprintf(" (tools: %s)", strings.Join(a.Tools, ", "))
		}
		fmt.Printf("%-20s %-25s %-12s %s%s\n", a.ID, a.Model, provider, a.Workspace, toolInfo)
	}
}

func cmdAgentAdd() {
	dir, _ := os.Getwd()
	configPath := filepath.Join(dir, "smithly.toml")

	if _, err := os.Stat(configPath); err != nil {
		log.Fatal("smithly.toml not found. Run 'smithly init' first.")
	}

	// Check for duplicate IDs
	cfg, err := config.Load(configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	reader := bufio.NewReader(os.Stdin)

	fmt.Print("Agent name: ")
	agentName, _ := reader.ReadString('\n')
	agentName = strings.TrimSpace(agentName)
	if agentName == "" {
		log.Fatal("Agent name is required")
	}

	for _, a := range cfg.Agents {
		if a.ID == agentName {
			log.Fatalf("Agent %q already exists", agentName)
		}
	}

	provider, baseURL, model, apiKey := promptLLMConfig(reader)

	wsPath := filepath.Join("workspaces", agentName)
	if err := os.MkdirAll(filepath.Join(dir, wsPath), 0o755); err != nil {
		log.Fatalf("Failed to create workspace directory: %v", err)
	}

	writeIfMissing(filepath.Join(dir, wsPath, "SOUL.md"),
		"You are a helpful, thoughtful AI assistant. You communicate clearly and concisely.")
	writeIfMissing(filepath.Join(dir, wsPath, "IDENTITY.toml"),
		fmt.Sprintf("name = %q\nemoji = \"🤖\"\n", agentName))

	agentCfg := config.AgentConfig{
		ID:        agentName,
		Model:     model,
		Workspace: wsPath,
		Provider:  provider,
		APIKey:    apiKey,
		BaseURL:   baseURL,
	}

	if err := config.AppendAgent(configPath, agentCfg); err != nil {
		log.Fatalf("Failed to add agent: %v", err)
	}

	fmt.Printf("\nAgent %q added. Chat with: smithly chat %s\n", agentName, agentName)
}

func cmdAgentRemove() {
	if len(os.Args) < 4 {
		fmt.Println("Usage: smithly agent remove <agent-id>")
		return
	}

	agentID := os.Args[3]
	configPath := "smithly.toml"

	if err := config.RemoveAgent(configPath, agentID); err != nil {
		log.Fatalf("Failed to remove agent: %v", err)
	}

	fmt.Printf("Agent %q removed from config.\n", agentID)
	fmt.Printf("Note: workspace directory was not deleted. Remove manually if desired.\n")
}
