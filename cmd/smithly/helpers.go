package main

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"os"
	"path/filepath"

	"smithly.dev/internal/agent"
	"smithly.dev/internal/config"
	"smithly.dev/internal/credentials"
	"smithly.dev/internal/db"
	"smithly.dev/internal/db/sqlite"
	"smithly.dev/internal/embedding"
	"smithly.dev/internal/memory"
	"smithly.dev/internal/sandbox"
	"smithly.dev/internal/skills"
	"smithly.dev/internal/tools"
	"smithly.dev/internal/workspace"
)

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

func loadCredentialStore(cfg *config.Config) credentials.Store {
	path := cfg.Credentials.Path
	if path == "" {
		path = "credentials.json"
	}
	return credentials.NewFileStore(path)
}

func loadAgent(ac config.AgentConfig, cfg *config.Config, store db.Store, credStore credentials.Store, sc skills.SidecarIface, proxyAddr string) (*agent.Agent, error) {
	ws, err := workspace.Load(ac.Workspace)
	if err != nil {
		return nil, fmt.Errorf("load workspace for %s: %w", ac.ID, err)
	}

	// Configure cost-based spending limits
	pricing := agent.LookupPricing(ac.Model)
	if ac.Pricing != nil {
		pricing = agent.ModelPricing{
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
				slog.Warn("failed to load skill", "skill", entry.Name(), "err", err)
				continue
			}
			if err := skillRegistry.Register(s); err != nil {
				slog.Warn("skill registration failed", "skill", entry.Name(), "err", err)
				continue
			}
			slog.Info("loaded skill", "skill", s.Manifest.Skill.Name)
		}
	}

	// Create sandbox provider for code skill execution
	codeRunner, err := sandbox.NewProvider(cfg.Sandbox, sc, cfg.DataStores, proxyAddr)
	if err != nil {
		return nil, fmt.Errorf("sandbox: %w", err)
	}

	// Populate services info for system prompt injection
	var services *agent.Services
	var svc agent.Services
	svc.DataStores = cfg.DataStores
	if cfg.Sidecar.Port != 0 || cfg.Sidecar.Bind != "" {
		bind := cfg.Sidecar.Bind
		if bind == "" {
			bind = "127.0.0.1"
		}
		port := cfg.Sidecar.Port
		if port == 0 {
			port = defaultSidecarPort
		}
		svc.SidecarURL = fmt.Sprintf("http://%s:%d", bind, port)
	}
	for _, s := range cfg.Secrets {
		svc.SecretNames = append(svc.SecretNames, s.Name)
	}
	if len(svc.DataStores) > 0 || svc.SidecarURL != "" || len(svc.SecretNames) > 0 {
		services = &svc
	}

	a := agent.New(agent.Config{
		ID:          ac.ID,
		Model:       ac.Model,
		Provider:    ac.Provider,
		BaseURL:     ac.BaseURL,
		APIKey:      ac.APIKey,
		MaxContext:  ac.MaxContext,
		Pricing:     pricing,
		CostWindows: agent.ParseCostWindows(costConfigs),
		Workspace:   ws,
		Store:       store,
		Skills:      skillRegistry,
		Services:    services,
		CodeRunner:  codeRunner,
	})

	// Create embedding client if configured
	var embedder embedding.Client
	if cfg.Memory != nil && cfg.Memory.EmbeddingModel != "" {
		embedder = embedding.NewClient(
			cfg.Memory.EmbeddingBaseURL,
			cfg.Memory.EmbeddingAPIKey,
			cfg.Memory.EmbeddingModel,
			cfg.Memory.Dimensions,
		)
	}

	// Create hybrid searcher
	searcher := memory.NewSearcher(store, embedder)

	// Register built-in tools (filtered by agent's tool config)
	registerTools(a.Tools, cfg, ac.Tools, skillRegistry, credStore, codeRunner, skillsDir, store, ac.ID, searcher)

	// Ensure agent exists in DB
	if _, err := store.GetAgent(context.Background(), ac.ID); err != nil {
		if err := store.CreateAgent(context.Background(), &db.Agent{
			ID:            ac.ID,
			Model:         ac.Model,
			WorkspacePath: ac.Workspace,
		}); err != nil {
			slog.Warn("failed to create agent in DB", "agent", ac.ID, "err", err)
		}
	}

	return a, nil
}

func registerTools(registry *tools.Registry, cfg *config.Config, allowedTools []string, skillRegistry *skills.Registry, credStore credentials.Store, codeRunner sandbox.Provider, skillsDir string, dbStore db.Store, agentID string, searcher *memory.Searcher) {
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
	switch cfg.Search.Provider {
	case "duckduckgo":
		searchProvider = tools.NewDuckDuckGoSearch()
	default: // "brave" or empty
		apiKey := cfg.Search.APIKey
		if apiKey == "" {
			apiKey = os.Getenv("BRAVE_API_KEY")
		}
		if apiKey != "" {
			searchProvider = tools.NewBraveSearch(apiKey)
		} else {
			// Fall back to DuckDuckGo if no Brave key
			slog.Warn("no BRAVE_API_KEY set, falling back to DuckDuckGo (limited results)")
			searchProvider = tools.NewDuckDuckGoSearch()
		}
	}

	// Build OAuth2 tool from config
	var oauth2Tool *tools.OAuth2Tool
	if len(cfg.OAuth2) > 0 && credStore != nil {
		oauth2Tool = tools.NewOAuth2Tool(cfg.OAuth2, credStore)
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

	// Add OAuth2 + API call tools if OAuth2 providers are configured
	if oauth2Tool != nil {
		allTools = append(allTools, oauth2Tool)
		allTools = append(allTools, tools.NewAPICall(oauth2Tool))
	}

	// Add notify tool if configured
	if cfg.Notify.NtfyTopic != "" {
		provider := tools.NewNtfyProvider(cfg.Notify.NtfyTopic, cfg.Notify.NtfyServer)
		allTools = append(allTools, tools.NewNotify(provider))
	}

	// Add read_skill tool if there are skills installed
	if skillRegistry != nil && len(skillRegistry.All()) > 0 {
		allTools = append(allTools, tools.NewReadSkill(skillRegistry))
	}

	// Add code skill tools if sandbox provider is available
	if codeRunner != nil {
		allTools = append(allTools, tools.NewRunCodeSkill(skillRegistry, codeRunner))
		allTools = append(allTools, tools.NewWriteSkill(skillRegistry, skillsDir))
	}

	// Add conversation memory tools
	if dbStore != nil && agentID != "" {
		allTools = append(allTools, tools.NewSearchHistory(dbStore, agentID, searcher))
		allTools = append(allTools, tools.NewReadHistory(dbStore, agentID))
	}
	for _, t := range allTools {
		if isAllowed(t.Name()) {
			registry.Register(t)
		}
	}
}
