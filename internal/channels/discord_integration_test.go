package channels_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"smithly.dev/internal/agent"
	"smithly.dev/internal/channels"
	"smithly.dev/internal/db/sqlite"
	"smithly.dev/internal/workspace"
)

// Integration tests require a real Discord bot token.
// Run with: DISCORD_BOT_TOKEN=... go test ./internal/channels/ -run TestIntegrationDiscord -v -timeout 120s

func skipUnlessDiscordIntegration(t *testing.T) string {
	t.Helper()
	token := os.Getenv("DISCORD_BOT_TOKEN")
	if token == "" {
		t.Skip("DISCORD_BOT_TOKEN not set — skipping integration test")
	}
	return token
}

func TestIntegrationDiscordConnect(t *testing.T) {
	token := skipUnlessDiscordIntegration(t)

	llmSrv := mockLLMServer()
	defer llmSrv.Close()

	store, err := sqlite.New(":memory:")
	if err != nil {
		t.Fatalf("create store: %v", err)
	}
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	defer store.Close()

	ws := &workspace.Workspace{
		Identity: workspace.Identity{Name: "IntegrationDiscordBot"},
	}
	a := agent.New(agent.Config{
		ID: "integration", Model: "test",
		BaseURL: llmSrv.URL, APIKey: "key",
		Workspace: ws, Store: store, Client: llmSrv.Client(),
	})

	dc := channels.NewDiscord(token, a, false)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Start will connect to Gateway, receive READY, then we cancel
	go func() {
		time.Sleep(5 * time.Second)
		cancel()
	}()

	err = dc.Start(ctx)
	if err != nil && err != context.Canceled && err != context.DeadlineExceeded {
		t.Fatalf("Start failed: %v", err)
	}
	t.Log("Discord Gateway connected — bot received READY")
}

func TestIntegrationDiscordRoundTrip(t *testing.T) {
	token := skipUnlessDiscordIntegration(t)

	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]any{"content": "Discord integration test passed!"}},
			},
		})
	}))
	defer llmSrv.Close()

	store, err := sqlite.New(":memory:")
	if err != nil {
		t.Fatalf("create store: %v", err)
	}
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	defer store.Close()

	ws := &workspace.Workspace{
		Identity: workspace.Identity{Name: "IntegrationDiscordBot"},
	}
	a := agent.New(agent.Config{
		ID: "integration", Model: "test",
		BaseURL: llmSrv.URL, APIKey: "key",
		Workspace: ws, Store: store, Client: llmSrv.Client(),
	})

	dc := channels.NewDiscord(token, a, false)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	t.Log("Bot is running. Send a DM to the Discord bot...")
	t.Log("The bot will reply with: \"Discord integration test passed!\"")
	t.Log("Waiting up to 90 seconds...")

	done := make(chan error, 1)
	go func() { done <- dc.Start(ctx) }()

	// Poll the DB for a message from channel:discord
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			msgs, _ := store.GetMessages(context.Background(), "integration", 10)
			for _, m := range msgs {
				if m.Source == "channel:discord" && m.Role == "user" {
					t.Logf("Received message from Discord: %q", m.Content)

					for _, m2 := range msgs {
						if m2.Role == "assistant" {
							t.Logf("Bot replied: %q", m2.Content)
						}
					}

					if m.Source != "channel:discord" {
						t.Errorf("source = %q, want channel:discord", m.Source)
					}

					t.Log("Integration test passed!")
					cancel()
					<-done
					return
				}
			}
		case <-ctx.Done():
			t.Fatal("Timeout — no message received. Did you send a DM to the Discord bot?")
			return
		}
	}
}
