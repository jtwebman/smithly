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

// Integration tests require a real Telegram bot token.
// Run with: TELEGRAM_BOT_TOKEN=... go test ./internal/channels/ -run TestIntegration -v -timeout 120s

func skipUnlessIntegration(t *testing.T) string {
	t.Helper()
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	if token == "" {
		t.Skip("TELEGRAM_BOT_TOKEN not set — skipping integration test")
	}
	return token
}

func TestIntegrationTelegramGetMe(t *testing.T) {
	token := skipUnlessIntegration(t)

	tg := &channels.Telegram{Token: token}

	// Start in a goroutine and cancel after getMe succeeds.
	// We just want to verify it connects.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Start will call getMe then begin polling — cancel right after it starts
	go func() {
		time.Sleep(2 * time.Second)
		cancel()
	}()

	err := tg.Start(ctx)
	if err != nil && err != context.Canceled && err != context.DeadlineExceeded {
		t.Fatalf("Start failed: %v", err)
	}
	t.Log("getMe succeeded — bot is connected")
}

func TestIntegrationTelegramRoundTrip(t *testing.T) {
	token := skipUnlessIntegration(t)

	// Mock LLM that always returns a recognizable response
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]any{"content": "Integration test passed! I received your message."}},
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
		Identity: workspace.Identity{Name: "IntegrationBot"},
	}
	a := agent.New(agent.Config{
		ID: "integration", Model: "test",
		BaseURL: llmSrv.URL, APIKey: "key",
		Workspace: ws, Store: store, Client: llmSrv.Client(),
	})

	tg := &channels.Telegram{
		Token: token,
		Agent: a,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	t.Log("Bot is running. Send a message to @smithly_test_bot in Telegram...")
	t.Log("The bot will reply with: \"Integration test passed! I received your message.\"")
	t.Log("Waiting up to 90 seconds...")

	done := make(chan error, 1)
	go func() { done <- tg.Start(ctx) }()

	// Poll the DB for a message from channel:telegram
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			msgs, _ := store.GetMessages(context.Background(), "integration", 10)
			for _, m := range msgs {
				if m.Source == "channel:telegram" && m.Role == "user" {
					t.Logf("Received message from Telegram: %q", m.Content)

					// Find the assistant response
					for _, m2 := range msgs {
						if m2.Role == "assistant" {
							t.Logf("Bot replied: %q", m2.Content)
						}
					}

					// Verify source tagging
					if m.Source != "channel:telegram" {
						t.Errorf("source = %q, want channel:telegram", m.Source)
					}

					t.Log("Integration test passed!")
					cancel()
					<-done
					return
				}
			}
		case <-ctx.Done():
			t.Fatal("Timeout — no message received. Did you send a message to @smithly_test_bot?")
			return
		}
	}
}
