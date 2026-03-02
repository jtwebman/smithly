package main

import (
	"context"
	"log"
	"os"

	"smithly.dev/internal/channels"
	"smithly.dev/internal/config"
)

// cmdChat starts an interactive CLI chat session.
func cmdChat() {
	cfg, store := loadConfig()
	credStore := loadCredentialStore(cfg)

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
		store.Close()
		if agentID != "" {
			log.Fatalf("Agent %q not found in config", agentID)
		}
		log.Fatal("No agents configured. Run 'smithly init' first.")
	}

	a, err := loadAgent(*ac, cfg, store, credStore, nil, "")
	if err != nil {
		store.Close()
		log.Fatalf("Failed to load agent: %v", err)
	}

	cli := channels.NewCLI(a)
	if err := cli.Run(context.Background()); err != nil {
		store.Close()
		log.Fatal(err)
	}
	store.Close()
}
