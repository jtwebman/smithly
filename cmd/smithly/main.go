package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"smithly.dev/internal/agent"
	"smithly.dev/internal/channels"
	"smithly.dev/internal/config"
	"smithly.dev/internal/db"
	"smithly.dev/internal/db/sqlite"
	"smithly.dev/internal/gateway"
	"smithly.dev/internal/skills"
	"smithly.dev/internal/tools"
	"smithly.dev/internal/workspace"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "init":
		cmdInit()
	case "start":
		cmdStart()
	case "chat":
		cmdChat()
	case "agent":
		cmdAgent()
	case "skill":
		cmdSkill()
	case "audit":
		cmdAudit()
	case "doctor":
		cmdDoctor()
	case "version":
		fmt.Println("smithly v0.1.0-dev")
	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`smithly — secure AI agent runtime

Commands:
  init      First-time setup wizard
  start     Start gateway + agents (HTTP API)
  chat      Interactive terminal chat with an agent
  agent     Manage agents (list, add, remove)
  skill     Manage instruction skills (list, add, remove)
  audit     Show audit log
  doctor    Check dependencies
  version   Print version

Run 'smithly <command> --help' for details.`)
}

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
	os.MkdirAll(filepath.Join(dir, wsPath), 0755)

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

// cmdStart runs the gateway and all agents.
func cmdStart() {
	cfg, store := loadConfig()
	defer store.Close()

	gw := gateway.New(cfg.Gateway.Bind, cfg.Gateway.Port, cfg.Gateway.Token, cfg.Gateway.RateLimit, store)

	// Graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Register agents
	for _, ac := range cfg.Agents {
		a, err := loadAgent(ac, cfg, store)
		if err != nil {
			log.Fatalf("Failed to load agent %s: %v", ac.ID, err)
		}
		gw.RegisterAgent(a)
		log.Printf("registered agent: %s (model: %s)", a.ID, a.Model)

		// Run BOOT.md if present
		if a.Workspace.Boot != "" {
			log.Printf("running BOOT.md for %s...", a.ID)
			if _, err := a.Boot(ctx, nil); err != nil {
				log.Printf("warning: boot for %s failed: %v", a.ID, err)
			}
		}

		// Start heartbeat if configured
		if ac.Heartbeat != nil && ac.Heartbeat.Enabled && a.Workspace.Heartbeat != "" {
			hc := agent.ParseHeartbeatConfig(ac.Heartbeat.Interval, ac.Heartbeat.QuietHours, ac.Heartbeat.AutoResume)
			a.StartHeartbeat(ctx, hc)
			log.Printf("heartbeat started for %s (every %s)", a.ID, hc.Interval)
		}
	}

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Println("shutting down...")
		gw.Shutdown(ctx)
		cancel()
	}()

	fmt.Printf("\nGateway: http://%s:%d\n", cfg.Gateway.Bind, cfg.Gateway.Port)
	fmt.Printf("Token:   %s\n\n", cfg.Gateway.Token)

	if err := gw.Start(); err != nil && ctx.Err() == nil {
		log.Fatalf("Gateway error: %v", err)
	}
}

// cmdChat starts an interactive CLI chat session.
func cmdChat() {
	cfg, store := loadConfig()
	defer store.Close()

	// Pick agent — first one, or specified via flag
	agentID := ""
	if len(os.Args) > 2 {
		agentID = os.Args[2]
	}

	var ac *config.AgentConfig
	for i := range cfg.Agents {
		if agentID == "" || cfg.Agents[i].ID == agentID {
			ac = &cfg.Agents[i]
			break
		}
	}
	if ac == nil {
		if agentID != "" {
			log.Fatalf("Agent %q not found in config", agentID)
		}
		log.Fatal("No agents configured. Run 'smithly init' first.")
	}

	a, err := loadAgent(*ac, cfg, store)
	if err != nil {
		log.Fatalf("Failed to load agent: %v", err)
	}

	cli := &channels.CLI{Agent: a}
	if err := cli.Run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

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
	os.MkdirAll(filepath.Join(dir, wsPath), 0755)

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

// cmdSkill manages instruction skills (list, add, remove).
func cmdSkill() {
	if len(os.Args) < 3 {
		fmt.Println(`Usage: smithly skill <subcommand>

Subcommands:
  list                List installed skills
  add <path>          Install a skill from a directory
  remove <name>       Remove an installed skill

Flags:
  --agent <id>        Target a specific agent (default: first agent)`)
		return
	}

	switch os.Args[2] {
	case "list":
		cmdSkillList()
	case "add":
		cmdSkillAdd()
	case "remove":
		cmdSkillRemove()
	default:
		fmt.Fprintf(os.Stderr, "unknown skill subcommand: %s\n", os.Args[2])
		os.Exit(1)
	}
}

func cmdSkillList() {
	cfg, agentID := parseSkillFlags(3)
	ac := findAgent(cfg, agentID)

	skillsDir := filepath.Join(ac.Workspace, "skills")
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		fmt.Println("No skills installed.")
		return
	}

	count := 0
	fmt.Printf("%-20s %-10s %s\n", "NAME", "VERSION", "DESCRIPTION")
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		s, err := skills.Load(filepath.Join(skillsDir, entry.Name()))
		if err != nil {
			fmt.Fprintf(os.Stderr, "  warning: %s: %v\n", entry.Name(), err)
			continue
		}
		desc := s.Manifest.Skill.Description
		if desc == "" {
			desc = "(no description)"
		}
		version := s.Manifest.Skill.Version
		if version == "" {
			version = "-"
		}
		fmt.Printf("%-20s %-10s %s\n", s.Manifest.Skill.Name, version, desc)
		count++
	}
	if count == 0 {
		fmt.Println("No skills installed.")
	}
}

func cmdSkillAdd() {
	cfg, agentID := parseSkillFlags(4)
	ac := findAgent(cfg, agentID)

	// Find the source path argument (skip --agent flags)
	srcPath := ""
	args := os.Args[3:]
	for i := 0; i < len(args); i++ {
		if args[i] == "--agent" {
			i++ // skip value
			continue
		}
		srcPath = args[i]
		break
	}
	if srcPath == "" {
		log.Fatal("Usage: smithly skill add <path> [--agent <id>]")
	}

	// Validate it's a loadable skill
	s, err := skills.Load(srcPath)
	if err != nil {
		log.Fatalf("Invalid skill at %s: %v", srcPath, err)
	}

	// Copy to workspace/skills/<name>/
	destDir := filepath.Join(ac.Workspace, "skills", s.Manifest.Skill.Name)
	if _, err := os.Stat(destDir); err == nil {
		log.Fatalf("Skill %q already installed. Remove it first with: smithly skill remove %s",
			s.Manifest.Skill.Name, s.Manifest.Skill.Name)
	}

	if err := copyDir(srcPath, destDir); err != nil {
		log.Fatalf("Failed to install skill: %v", err)
	}

	fmt.Printf("Installed skill %q into %s\n", s.Manifest.Skill.Name, destDir)
}

func cmdSkillRemove() {
	cfg, agentID := parseSkillFlags(4)
	ac := findAgent(cfg, agentID)

	// Find the skill name argument (skip --agent flags)
	skillName := ""
	args := os.Args[3:]
	for i := 0; i < len(args); i++ {
		if args[i] == "--agent" {
			i++ // skip value
			continue
		}
		skillName = args[i]
		break
	}
	if skillName == "" {
		log.Fatal("Usage: smithly skill remove <name> [--agent <id>]")
	}

	destDir := filepath.Join(ac.Workspace, "skills", skillName)
	if _, err := os.Stat(destDir); err != nil {
		log.Fatalf("Skill %q not found in %s", skillName, filepath.Join(ac.Workspace, "skills"))
	}

	if err := os.RemoveAll(destDir); err != nil {
		log.Fatalf("Failed to remove skill: %v", err)
	}

	fmt.Printf("Removed skill %q\n", skillName)
}

// parseSkillFlags extracts --agent flag from args starting at position minArgs.
func parseSkillFlags(minArgs int) (*config.Config, string) {
	cfg, err := config.Load("smithly.toml")
	if err != nil {
		log.Fatalf("Failed to load config: %v\nRun 'smithly init' first.", err)
	}

	agentID := ""
	args := os.Args[3:]
	for i := 0; i < len(args); i++ {
		if args[i] == "--agent" && i+1 < len(args) {
			agentID = args[i+1]
			break
		}
	}
	return cfg, agentID
}

// findAgent looks up an agent config by ID, or returns the first agent.
func findAgent(cfg *config.Config, agentID string) *config.AgentConfig {
	for i := range cfg.Agents {
		if agentID == "" || cfg.Agents[i].ID == agentID {
			return &cfg.Agents[i]
		}
	}
	if agentID != "" {
		log.Fatalf("Agent %q not found in config", agentID)
	}
	log.Fatal("No agents configured. Run 'smithly init' first.")
	return nil
}

// copyDir recursively copies a directory.
func copyDir(src, dst string) error {
	if err := os.MkdirAll(dst, 0755); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			data, err := os.ReadFile(srcPath)
			if err != nil {
				return err
			}
			if err := os.WriteFile(dstPath, data, 0644); err != nil {
				return err
			}
		}
	}
	return nil
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

// cmdAudit shows the audit log.
func cmdAudit() {
	_, store := loadConfig()
	defer store.Close()

	query := db.AuditQuery{Limit: 50}

	// Parse flags: smithly audit [--agent ID] [--limit N]
	args := os.Args[2:]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--agent":
			if i+1 < len(args) {
				i++
				query.AgentID = args[i]
			}
		case "--limit":
			if i+1 < len(args) {
				i++
				if n, err := strconv.Atoi(args[i]); err == nil {
					query.Limit = n
				}
			}
		}
	}

	entries, err := store.GetAuditLog(context.Background(), query)
	if err != nil {
		log.Fatalf("Failed to read audit log: %v", err)
	}

	if len(entries) == 0 {
		fmt.Println("No audit entries found.")
		return
	}

	for _, e := range entries {
		target := ""
		if e.Target != "" {
			target = " → " + e.Target
		}
		details := ""
		if e.Details != "" {
			d := e.Details
			if len(d) > 80 {
				d = d[:80] + "..."
			}
			details = "  " + d
		}
		fmt.Printf("%s  %-20s  %-12s%s%s\n",
			e.Timestamp.Format("2006-01-02 15:04:05"),
			e.Actor,
			e.Action,
			target,
			details,
		)
	}
}

// cmdDoctor checks that dependencies are available.
func cmdDoctor() {
	fmt.Println("Smithly Doctor")
	fmt.Println()

	// Check for smithly.toml
	if _, err := os.Stat("smithly.toml"); err == nil {
		fmt.Println("  ✓ smithly.toml found")
	} else {
		fmt.Println("  ✗ smithly.toml not found (run 'smithly init')")
	}

	// Check for Docker
	if _, err := os.Stat("/var/run/docker.sock"); err == nil {
		fmt.Println("  ✓ Docker socket found")
	} else {
		fmt.Println("  - Docker not available (optional, needed for sandbox)")
	}

	fmt.Println()
}

// --- helpers ---

func loadConfig() (*config.Config, db.Store) {
	cfg, err := config.Load("smithly.toml")
	if err != nil {
		log.Fatalf("Failed to load config: %v\nRun 'smithly init' to create one.", err)
	}

	store, err := sqlite.New(cfg.Storage.Database)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}

	if err := store.Migrate(context.Background()); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}

	return cfg, store
}

func loadAgent(ac config.AgentConfig, cfg *config.Config, store db.Store) (*agent.Agent, error) {
	ws, err := workspace.Load(ac.Workspace)
	if err != nil {
		return nil, fmt.Errorf("load workspace for %s: %w", ac.ID, err)
	}

	a := agent.New(ac.ID, ac.Model, ac.BaseURL, ac.APIKey, ws, store)
	a.MaxContext = ac.MaxContext

	// Configure cost-based spending limits
	a.Pricing = agent.LookupPricing(ac.Model)
	if ac.Pricing != nil {
		a.Pricing = agent.ModelPricing{
			InputPerMillion:       ac.Pricing.InputPerMillion,
			OutputPerMillion:      ac.Pricing.OutputPerMillion,
			CachedInputPerMillion: ac.Pricing.CachedPerMillion,
		}
	}
	var costConfigs []agent.CostLimitConfig
	for _, cl := range ac.CostLimits {
		costConfigs = append(costConfigs, agent.CostLimitConfig{
			Dollars: cl.Dollars,
			Window:  cl.Window,
		})
	}
	a.CostWindows = agent.ParseCostWindows(costConfigs)

	// Load instruction skills from workspace skills/ directory
	skillRegistry := skills.NewRegistry()
	skillsDir := filepath.Join(ac.Workspace, "skills")
	if entries, err := os.ReadDir(skillsDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			s, err := skills.Load(filepath.Join(skillsDir, entry.Name()))
			if err != nil {
				log.Printf("warning: failed to load skill %s: %v", entry.Name(), err)
				continue
			}
			if err := skillRegistry.Add(s); err != nil {
				log.Printf("warning: skill %s: %v", entry.Name(), err)
				continue
			}
			log.Printf("loaded skill: %s", s.Manifest.Skill.Name)
		}
	}
	a.Skills = skillRegistry

	// Register built-in tools (filtered by agent's tool config)
	registerTools(a.Tools, cfg.Search, ac.Tools, skillRegistry)

	// Ensure agent exists in DB
	if _, err := store.GetAgent(context.Background(), ac.ID); err != nil {
		store.CreateAgent(context.Background(), &db.Agent{
			ID:            ac.ID,
			Model:         ac.Model,
			WorkspacePath: ac.Workspace,
		})
	}

	return a, nil
}

func registerTools(registry *tools.Registry, searchCfg config.SearchConfig, allowedTools []string, skillRegistry *skills.Registry) {
	// Build allowed set (empty = all allowed)
	allowed := make(map[string]bool)
	for _, t := range allowedTools {
		allowed[t] = true
	}
	isAllowed := func(name string) bool {
		return len(allowed) == 0 || allowed[name]
	}

	// Pick search provider based on config
	var searchProvider tools.SearchProvider
	switch searchCfg.Provider {
	case "duckduckgo":
		searchProvider = tools.NewDuckDuckGoSearch()
	default: // "brave" or empty
		apiKey := searchCfg.APIKey
		if apiKey == "" {
			apiKey = os.Getenv("BRAVE_API_KEY")
		}
		if apiKey != "" {
			searchProvider = tools.NewBraveSearch(apiKey)
		} else {
			// Fall back to DuckDuckGo if no Brave key
			log.Println("warning: no BRAVE_API_KEY set, falling back to DuckDuckGo (limited results)")
			searchProvider = tools.NewDuckDuckGoSearch()
		}
	}

	allTools := []tools.Tool{
		tools.NewSearchWithProvider(searchProvider),
		tools.NewFetch(),
		tools.NewBash(),
		tools.NewReadFile(""),
		tools.NewWriteFile(""),
		tools.NewListFiles(""),
		tools.NewClaudeCode(),
	}
	// Add read_skill tool if there are skills installed
	if skillRegistry != nil && len(skillRegistry.All()) > 0 {
		allTools = append(allTools, tools.NewReadSkill(skillRegistry))
	}
	for _, t := range allTools {
		if isAllowed(t.Name()) {
			registry.Register(t)
		}
	}
}

func writeIfMissing(path, content string) {
	if _, err := os.Stat(path); err == nil {
		return
	}
	os.WriteFile(path, []byte(content+"\n"), 0644)
}
