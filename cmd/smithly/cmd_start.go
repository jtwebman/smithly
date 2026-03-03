package main

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"smithly.dev/internal/agent"
	"smithly.dev/internal/channels"
	"smithly.dev/internal/config"
	"smithly.dev/internal/credentials"
	"smithly.dev/internal/db"
	"smithly.dev/internal/gatekeeper"
	"smithly.dev/internal/gateway"
	"smithly.dev/internal/sidecar"
	"smithly.dev/internal/store"
	"smithly.dev/internal/tools"
	"smithly.dev/internal/tunnel"
	"smithly.dev/internal/webhook"
)

// cmdStart runs the gateway and all agents.
func cmdStart() {
	cfg, dbStore := loadConfig()
	credStore := loadCredentialStore(cfg)

	gw := gateway.New(cfg.Gateway.Bind, cfg.Gateway.Port, cfg.Gateway.Token, cfg.Gateway.RateLimit, dbStore)

	// Start sidecar
	sc := startSidecar(cfg, dbStore, credStore)

	// Start gatekeeper proxy
	gkProxy := startGatekeeper(cfg, dbStore)

	// Graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())

	// Register agents
	var proxyAddr string
	if gkProxy != nil {
		proxyAddr = gkProxy.Addr()
	}
	for _, ac := range cfg.Agents {
		a, err := loadAgent(ac, cfg, dbStore, credStore, sc, proxyAddr)
		if err != nil {
			cancel()
			dbStore.Close()
			log.Fatalf("Failed to load agent %s: %v", ac.ID, err)
		}
		gw.RegisterAgent(a)
		slog.Info("registered agent", "agent", a.ID, "model", a.Model)

		// Run BOOT.md if present
		if a.Workspace.Boot != "" {
			slog.Info("running BOOT.md", "agent", a.ID)
			if _, err := a.Boot(ctx, nil); err != nil {
				slog.Warn("boot failed", "agent", a.ID, "err", err)
			}
		}

		// Start heartbeat if configured
		if ac.Heartbeat != nil && ac.Heartbeat.Enabled {
			if ac.Heartbeat.Skill != "" || a.Workspace.Heartbeat != "" {
				hc := agent.ParseHeartbeatConfig(ac.Heartbeat.Interval, ac.Heartbeat.QuietHours, ac.Heartbeat.AutoResume, ac.Heartbeat.Skill)
				a.StartHeartbeat(ctx, hc)
				if hc.Skill != "" {
					slog.Info("heartbeat started", "agent", a.ID, "skill", hc.Skill, "interval", hc.Interval)
				} else {
					slog.Info("heartbeat started", "agent", a.ID, "interval", hc.Interval)
				}
			}
		}
	}

	// Start channel adapters
	for _, ch := range cfg.Channels {
		resolver := &channels.BindingResolver{
			Store:        dbStore,
			Agents:       gw,
			DefaultAgent: ch.Agent,
		}

		switch ch.Type {
		case "telegram":
			// Verify default agent exists
			if _, ok := gw.GetAgent(ch.Agent); !ok {
				cancel()
				dbStore.Close()
				log.Fatalf("channel %s: agent %q not found", ch.Type, ch.Agent)
			}
			tg := channels.NewTelegramWithResolver(ch.BotToken, resolver, ch.AutoApprove)
			go func(tg *channels.Telegram) {
				if err := tg.Start(ctx); err != nil && ctx.Err() == nil {
					slog.Error("telegram channel error", "err", err)
				}
			}(tg)
			slog.Info("channel started", "type", "telegram", "agent", ch.Agent)
		case "discord":
			// Verify default agent exists
			if _, ok := gw.GetAgent(ch.Agent); !ok {
				cancel()
				dbStore.Close()
				log.Fatalf("channel %s: agent %q not found", ch.Type, ch.Agent)
			}
			dc := channels.NewDiscordWithResolver(ch.BotToken, resolver, ch.AutoApprove)
			go func(dc *channels.Discord) {
				if err := dc.Start(ctx); err != nil && ctx.Err() == nil {
					slog.Error("discord channel error", "err", err)
				}
			}(dc)
			slog.Info("channel started", "type", "discord", "agent", ch.Agent)
		default:
			cancel()
			dbStore.Close()
			log.Fatalf("unknown channel type: %s", ch.Type)
		}
	}

	// Start webhook server + tunnel
	var whServer *webhook.Server
	var whTunnel tunnel.Tunnel
	if len(cfg.Webhooks) > 0 {
		webhooks := make(map[string]*webhook.WebhookConfig, len(cfg.Webhooks))
		for _, wh := range cfg.Webhooks {
			// Verify agent exists
			if _, ok := gw.GetAgent(wh.Agent); !ok {
				cancel()
				dbStore.Close()
				log.Fatalf("webhook %s: agent %q not found", wh.Name, wh.Agent)
			}
			webhooks[wh.Name] = &webhook.WebhookConfig{
				Name:        wh.Name,
				Secret:      wh.Secret,
				AgentID:     wh.Agent,
				AutoApprove: wh.AutoApprove,
			}
		}

		whBind := cfg.Webhook.Bind
		if whBind == "" {
			whBind = "127.0.0.1"
		}
		whPort := cfg.Webhook.Port
		if whPort == 0 {
			whPort = defaultWebhookPort
		}

		whServer = &webhook.Server{
			Bind:     whBind,
			Port:     whPort,
			Webhooks: webhooks,
			Store:    dbStore,
			Agents:   gw,
		}

		go func() {
			if err := whServer.Start(); err != nil && ctx.Err() == nil {
				slog.Error("webhook server error", "err", err)
			}
		}()

		// Start tunnel if configured
		whAddr := fmt.Sprintf("%s:%d", whBind, whPort)
		if cfg.Webhook.Tunnel.Provider == "ngrok" {
			whTunnel = &tunnel.Ngrok{
				Authtoken: cfg.Webhook.Tunnel.Authtoken,
				Domain:    cfg.Webhook.Tunnel.Domain,
			}
			publicURL, err := whTunnel.Start(ctx, whAddr)
			if err != nil {
				slog.Error("ngrok tunnel failed", "err", err)
			} else {
				slog.Info("webhook tunnel active", "url", publicURL)
			}
		}
	}

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		slog.Info("shutting down")
		if whTunnel != nil {
			if err := whTunnel.Stop(ctx); err != nil {
				slog.Error("tunnel shutdown error", "err", err)
			}
		}
		if whServer != nil {
			if err := whServer.Shutdown(ctx); err != nil {
				slog.Error("webhook server shutdown error", "err", err)
			}
		}
		if gkProxy != nil {
			if err := gkProxy.Shutdown(ctx); err != nil {
				slog.Error("gatekeeper shutdown error", "err", err)
			}
		}
		if err := sc.Shutdown(ctx); err != nil {
			slog.Error("sidecar shutdown error", "err", err)
		}
		if err := gw.Shutdown(ctx); err != nil {
			slog.Error("gateway shutdown error", "err", err)
		}
		cancel()
	}()

	fmt.Printf("\nGateway:    http://%s:%d\n", cfg.Gateway.Bind, cfg.Gateway.Port)
	fmt.Printf("Sidecar:    %s\n", sc.URL())
	if gkProxy != nil {
		fmt.Printf("Gatekeeper: http://%s\n", gkProxy.Addr())
	}
	if whServer != nil {
		whBind := cfg.Webhook.Bind
		if whBind == "" {
			whBind = "127.0.0.1"
		}
		whPort := cfg.Webhook.Port
		if whPort == 0 {
			whPort = defaultWebhookPort
		}
		fmt.Printf("Webhooks:   http://%s:%d\n", whBind, whPort)
	}
	fmt.Printf("Sandbox:    %s\n", cfg.Sandbox.Provider)
	fmt.Printf("Token:      %s\n\n", cfg.Gateway.Token)

	if cfg.Sandbox.Provider == "" || cfg.Sandbox.Provider == "none" {
		slog.Warn("sandbox provider is none — code skills run as unsandboxed subprocesses")
	}

	if err := gw.Start(); err != nil && ctx.Err() == nil {
		cancel()
		dbStore.Close()
		log.Fatalf("Gateway error: %v", err)
	}
	dbStore.Close()
}

// startSidecar creates and starts the sidecar HTTP server in a goroutine.
func startSidecar(cfg *config.Config, dbStore db.Store, credStore credentials.Store) *sidecar.Sidecar {
	// Build OAuth2 tool for sidecar
	var oauth2Tool *tools.OAuth2Tool
	if len(cfg.OAuth2) > 0 && credStore != nil {
		oauth2Tool = tools.NewOAuth2Tool(cfg.OAuth2, credStore)
	}

	// Build notify provider for sidecar
	var notifyProvider tools.NotifyProvider
	if cfg.Notify.NtfyTopic != "" {
		notifyProvider = tools.NewNtfyProvider(cfg.Notify.NtfyTopic, cfg.Notify.NtfyServer)
	}

	// Build object store — uses a separate SQLite file so direct-connecting
	// skills can't access the agent runtime tables.
	var objStore store.Store
	storeDBPath := strings.TrimSuffix(cfg.Storage.Database, ".db") + "_store.db"
	objStoreDB, err := store.New(storeDBPath)
	if err != nil {
		slog.Warn("could not open store DB", "path", storeDBPath, "err", err)
	} else {
		objStore = objStoreDB
	}

	// Build secret store from config
	secrets := loadSecretStore(cfg)

	bind := cfg.Sidecar.Bind
	if bind == "" {
		bind = "127.0.0.1"
	}
	port := cfg.Sidecar.Port
	if port == 0 {
		port = defaultSidecarPort
	}

	sc := sidecar.New(sidecar.Config{
		Bind:     bind,
		Port:     port,
		OAuth2:   oauth2Tool,
		Notify:   notifyProvider,
		Audit:    dbStore,
		ObjStore: objStore,
		Secrets:  secrets,
	})

	go func() {
		slog.Info("sidecar listening", "addr", sc.URL())
		if err := sc.Start(); err != nil {
			slog.Error("sidecar error", "err", err)
		}
	}()

	return sc
}

// startGatekeeper creates and starts the gatekeeper proxy in a goroutine.
func startGatekeeper(cfg *config.Config, dbStore db.Store) *gatekeeper.Proxy {
	bind := cfg.Gatekeeper.Bind
	if bind == "" {
		bind = "127.0.0.1"
	}
	port := cfg.Gatekeeper.Port
	if port == 0 {
		port = defaultGatekeeperPort
	}

	gk := gatekeeper.New(dbStore, nil)
	proxy := gatekeeper.NewProxy(gk, dbStore, bind, port)

	go func() {
		slog.Info("gatekeeper proxy listening", "addr", proxy.Addr())
		if err := proxy.Start(); err != nil {
			slog.Error("gatekeeper error", "err", err)
		}
	}()

	return proxy
}

// configSecretStore implements sidecar.SecretStore from config entries.
type configSecretStore struct {
	secrets map[string]string
}

func (s *configSecretStore) GetSecret(name string) (string, bool) {
	v, ok := s.secrets[name]
	return v, ok
}

func loadSecretStore(cfg *config.Config) sidecar.SecretStore {
	secrets := make(map[string]string, len(cfg.Secrets))
	for _, s := range cfg.Secrets {
		if s.Env != "" {
			// Read from controller's environment — skill never sees the env var
			secrets[s.Name] = os.Getenv(s.Env)
		} else {
			secrets[s.Name] = s.Value
		}
	}
	if len(secrets) == 0 {
		return nil
	}
	return &configSecretStore{secrets: secrets}
}
