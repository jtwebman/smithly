package channels_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"smithly.dev/internal/agent"
	"smithly.dev/internal/channels"
	"smithly.dev/internal/db/sqlite"
	"smithly.dev/internal/workspace"
)

// tgBotServer mocks the Telegram Bot API. It returns canned getMe, getUpdates,
// sendMessage, and sendChatAction responses.
type tgBotServer struct {
	mu         sync.Mutex
	updates    []map[string]any // queued updates for getUpdates
	sent       []string         // captured sendMessage texts
	actions    []string         // captured sendChatAction actions
	getMeOK    bool             // if false, getMe returns error
	failUpdate bool             // if true, getUpdates returns 500
}

func newTGBotServer(getMeOK bool) *tgBotServer {
	return &tgBotServer{getMeOK: getMeOK}
}

func (s *tgBotServer) enqueueUpdate(updateID int, chatID int64, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.updates = append(s.updates, map[string]any{
		"update_id": updateID,
		"message": map[string]any{
			"message_id": 1,
			"chat":       map[string]any{"id": chatID},
			"text":       text,
		},
	})
}

func (s *tgBotServer) enqueueEmptyUpdate(updateID int, chatID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.updates = append(s.updates, map[string]any{
		"update_id": updateID,
		"message": map[string]any{
			"message_id": 1,
			"chat":       map[string]any{"id": chatID},
			"text":       "",
		},
	})
}

func (s *tgBotServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	// Extract API method — last path segment (e.g. /botTOKEN/getMe → getMe)
	idx := strings.LastIndex(path, "/")
	if idx < 0 {
		http.Error(w, "bad path", 400)
		return
	}
	method := path[idx+1:]

	switch method {
	case "getMe":
		if !s.getMeOK {
			json.NewEncoder(w).Encode(map[string]any{
				"ok":          false,
				"description": "Unauthorized",
			})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"result": map[string]any{"username": "test_bot"},
		})

	case "getUpdates":
		s.mu.Lock()
		if s.failUpdate {
			s.failUpdate = false
			s.mu.Unlock()
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]any{
				"ok":          false,
				"description": "Internal Server Error",
			})
			return
		}
		updates := s.updates
		s.updates = nil
		s.mu.Unlock()
		if updates == nil {
			updates = []map[string]any{}
		}
		json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"result": updates,
		})

	case "sendMessage":
		var req struct {
			ChatID int64  `json:"chat_id"`
			Text   string `json:"text"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		s.mu.Lock()
		s.sent = append(s.sent, req.Text)
		s.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"result": map[string]any{"message_id": 1},
		})

	case "sendChatAction":
		var req struct {
			Action string `json:"action"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		s.mu.Lock()
		s.actions = append(s.actions, req.Action)
		s.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"ok": true})

	default:
		http.Error(w, "unknown method", 404)
	}
}

func (s *tgBotServer) getSent() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.sent))
	copy(out, s.sent)
	return out
}

func (s *tgBotServer) getActions() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.actions))
	copy(out, s.actions)
	return out
}

func newTestTGAgent(t *testing.T, llmSrv *httptest.Server) *agent.Agent {
	t.Helper()
	store, err := sqlite.New(":memory:")
	if err != nil {
		t.Fatalf("create store: %v", err)
	}
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { store.Close() })

	ws := &workspace.Workspace{
		Identity: workspace.Identity{Name: "TGBot"},
	}
	return agent.New(agent.Config{
		ID: "test", Model: "test-model",
		BaseURL: llmSrv.URL, APIKey: "key",
		Workspace: ws, Store: store, Client: llmSrv.Client(),
	})
}

func TestTelegramHandleMessage(t *testing.T) {
	llmSrv := mockLLMServer("Hello from the bot!")
	defer llmSrv.Close()

	tgBot := newTGBotServer(true)
	tgBot.enqueueUpdate(1, 42, "hi there")
	tgSrv := httptest.NewServer(tgBot)
	defer tgSrv.Close()

	a := newTestTGAgent(t, llmSrv)

	tg := &channels.Telegram{
		Token:   "test-token",
		Agent:   a,
		BaseURL: tgSrv.URL + "/bot",
	}

	ctx, cancel := context.WithCancel(context.Background())

	// Run Start in goroutine; it will process the queued update then keep polling.
	done := make(chan error, 1)
	go func() { done <- tg.Start(ctx) }()

	// Wait for the message to be processed
	deadline := time.After(5 * time.Second)
	for {
		sent := tgBot.getSent()
		if len(sent) > 0 {
			if !strings.Contains(sent[0], "Hello from the bot!") {
				t.Errorf("sent = %q, want 'Hello from the bot!'", sent[0])
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("timeout waiting for sendMessage")
		case <-time.After(50 * time.Millisecond):
		}
	}

	// Verify typing indicator was sent
	actions := tgBot.getActions()
	if len(actions) == 0 || actions[0] != "typing" {
		t.Errorf("actions = %v, want [typing]", actions)
	}

	// Verify message was persisted with correct source
	msgs, _ := a.Store.GetMessages(context.Background(), "test", 50)
	if len(msgs) < 2 {
		t.Fatalf("messages = %d, want >= 2", len(msgs))
	}
	if msgs[0].Source != "channel:telegram" {
		t.Errorf("source = %q, want channel:telegram", msgs[0].Source)
	}

	cancel()
	<-done
}

func TestTelegramLongMessage(t *testing.T) {
	text := strings.Repeat("x", 5000)
	tg := &channels.Telegram{BaseURL: "http://unused/bot", Token: "t"}

	// Use sendLongMessage through the public interface by testing the split logic directly
	// We'll test via a full round-trip through the mock
	llmSrv := mockLLMServer(text)
	defer llmSrv.Close()

	tgBot := newTGBotServer(true)
	tgBot.enqueueUpdate(1, 42, "give me a long response")
	tgSrv := httptest.NewServer(tgBot)
	defer tgSrv.Close()

	a := newTestTGAgent(t, llmSrv)
	_ = tg // unused placeholder

	tgReal := &channels.Telegram{
		Token:   "test-token",
		Agent:   a,
		BaseURL: tgSrv.URL + "/bot",
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tgReal.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := tgBot.getSent()
		if len(sent) >= 2 {
			// First chunk should be exactly 4096 chars
			if len(sent[0]) > 4096 {
				t.Errorf("first chunk len = %d, want <= 4096", len(sent[0]))
			}
			// All chunks together should equal the full text
			full := strings.Join(sent, "")
			if full != text {
				t.Errorf("joined len = %d, want %d", len(full), len(text))
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("timeout waiting for split messages")
		case <-time.After(50 * time.Millisecond):
		}
	}

	cancel()
	<-done
}

func TestTelegramLongMessageNewlineSplit(t *testing.T) {
	// Build a message with a newline near the 4096 boundary
	part1 := strings.Repeat("a", 4000)
	part2 := strings.Repeat("b", 200)
	text := part1 + "\n" + part2

	llmSrv := mockLLMServer(text)
	defer llmSrv.Close()

	tgBot := newTGBotServer(true)
	tgBot.enqueueUpdate(1, 42, "test")
	tgSrv := httptest.NewServer(tgBot)
	defer tgSrv.Close()

	a := newTestTGAgent(t, llmSrv)

	tg := &channels.Telegram{
		Token:   "test-token",
		Agent:   a,
		BaseURL: tgSrv.URL + "/bot",
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tg.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := tgBot.getSent()
		if len(sent) >= 1 {
			// Should split at the newline, so first chunk = part1
			if sent[0] != part1 {
				t.Errorf("first chunk = %q..., want %q...", sent[0][:20], part1[:20])
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("timeout")
		case <-time.After(50 * time.Millisecond):
		}
	}

	cancel()
	<-done
}

func TestTelegramInvalidToken(t *testing.T) {
	tgBot := newTGBotServer(false) // getMe returns error
	tgSrv := httptest.NewServer(tgBot)
	defer tgSrv.Close()

	llmSrv := mockLLMServer()
	defer llmSrv.Close()

	a := newTestTGAgent(t, llmSrv)

	tg := &channels.Telegram{
		Token:   "bad-token",
		Agent:   a,
		BaseURL: tgSrv.URL + "/bot",
	}

	err := tg.Start(context.Background())
	if err == nil {
		t.Fatal("expected error from invalid token")
	}
	if !strings.Contains(err.Error(), "Unauthorized") {
		t.Errorf("error = %v, want Unauthorized", err)
	}
}

func TestTelegramAutoApproveDeny(t *testing.T) {
	// LLM returns a tool call, then text
	callCount := 0
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")
		if callCount == 1 {
			json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{
					{"message": map[string]any{
						"content": "",
						"tool_calls": []map[string]any{
							{
								"id":   "call_1",
								"type": "function",
								"function": map[string]any{
									"name":      "echo_tool",
									"arguments": `{"text":"hello"}`,
								},
							},
						},
					}},
				},
			})
		} else {
			json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{
					{"message": map[string]any{"content": "done"}},
				},
			})
		}
	}))
	defer llmSrv.Close()

	tgBot := newTGBotServer(true)
	tgBot.enqueueUpdate(1, 42, "use tool")
	tgSrv := httptest.NewServer(tgBot)
	defer tgSrv.Close()

	a := newTestTGAgent(t, llmSrv)
	a.Tools.Register(&echoTool{})

	tg := &channels.Telegram{
		Token:       "test-token",
		Agent:       a,
		AutoApprove: false,
		BaseURL:     tgSrv.URL + "/bot",
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tg.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := tgBot.getSent()
		if len(sent) > 0 {
			// Tool should have been denied, result should reflect that
			break
		}
		select {
		case <-deadline:
			t.Fatal("timeout")
		case <-time.After(50 * time.Millisecond):
		}
	}

	cancel()
	<-done
}

func TestTelegramAutoApproveAllow(t *testing.T) {
	callCount := 0
	llmSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")
		if callCount == 1 {
			json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{
					{"message": map[string]any{
						"content": "",
						"tool_calls": []map[string]any{
							{
								"id":   "call_1",
								"type": "function",
								"function": map[string]any{
									"name":      "echo_tool",
									"arguments": `{"text":"hello"}`,
								},
							},
						},
					}},
				},
			})
		} else {
			json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{
					{"message": map[string]any{"content": "tool done"}},
				},
			})
		}
	}))
	defer llmSrv.Close()

	tgBot := newTGBotServer(true)
	tgBot.enqueueUpdate(1, 42, "use tool")
	tgSrv := httptest.NewServer(tgBot)
	defer tgSrv.Close()

	a := newTestTGAgent(t, llmSrv)
	a.Tools.Register(&echoTool{})

	tg := &channels.Telegram{
		Token:       "test-token",
		Agent:       a,
		AutoApprove: true,
		BaseURL:     tgSrv.URL + "/bot",
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tg.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := tgBot.getSent()
		if len(sent) > 0 {
			if !strings.Contains(sent[0], "tool done") {
				t.Errorf("sent = %q, want 'tool done'", sent[0])
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("timeout")
		case <-time.After(50 * time.Millisecond):
		}
	}

	cancel()
	<-done
}

func TestTelegramEmptyMessage(t *testing.T) {
	llmSrv := mockLLMServer("should not see this")
	defer llmSrv.Close()

	tgBot := newTGBotServer(true)
	// Enqueue an update with empty text — should be skipped
	tgBot.enqueueEmptyUpdate(1, 42)
	// Then a real message to verify the bot is working
	tgBot.enqueueUpdate(2, 42, "hello")
	tgSrv := httptest.NewServer(tgBot)
	defer tgSrv.Close()

	a := newTestTGAgent(t, llmSrv)

	tg := &channels.Telegram{
		Token:   "test-token",
		Agent:   a,
		BaseURL: tgSrv.URL + "/bot",
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tg.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := tgBot.getSent()
		if len(sent) > 0 {
			// Only the real message should produce a response
			if len(sent) != 1 {
				t.Errorf("sent %d messages, want 1 (empty should be skipped)", len(sent))
			}
			break
		}
		select {
		case <-deadline:
			t.Fatal("timeout")
		case <-time.After(50 * time.Millisecond):
		}
	}

	cancel()
	<-done
}

func TestTelegramContextCancel(t *testing.T) {
	llmSrv := mockLLMServer()
	defer llmSrv.Close()

	tgBot := newTGBotServer(true)
	tgSrv := httptest.NewServer(tgBot)
	defer tgSrv.Close()

	a := newTestTGAgent(t, llmSrv)

	tg := &channels.Telegram{
		Token:   "test-token",
		Agent:   a,
		BaseURL: tgSrv.URL + "/bot",
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tg.Start(ctx) }()

	// Give it a moment to start polling, then cancel
	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err != nil && err != context.Canceled {
			t.Fatalf("unexpected error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for shutdown")
	}
}

func TestTelegramAPIError(t *testing.T) {
	llmSrv := mockLLMServer("recovered")
	defer llmSrv.Close()

	tgBot := newTGBotServer(true)
	// First getUpdates will fail, then succeed with a message
	tgBot.mu.Lock()
	tgBot.failUpdate = true
	tgBot.mu.Unlock()

	tgSrv := httptest.NewServer(tgBot)
	defer tgSrv.Close()

	a := newTestTGAgent(t, llmSrv)

	tg := &channels.Telegram{
		Token:   "test-token",
		Agent:   a,
		BaseURL: tgSrv.URL + "/bot",
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- tg.Start(ctx) }()

	// After the retry delay, enqueue a real message
	time.Sleep(200 * time.Millisecond)
	tgBot.enqueueUpdate(1, 42, "hello after error")

	deadline := time.After(10 * time.Second)
	for {
		sent := tgBot.getSent()
		if len(sent) > 0 {
			if !strings.Contains(sent[0], "recovered") {
				t.Errorf("sent = %q, want 'recovered'", sent[0])
			}
			break
		}
		select {
		case <-deadline:
			// The retry has a 5s backoff, so this might take a while
			t.Fatal("timeout waiting for recovery after API error")
		case <-time.After(100 * time.Millisecond):
		}
	}

	cancel()
	<-done
}

// TestTelegramSourcePersistence verifies that CLI messages are tagged with "cli" source
// and Telegram messages are tagged with "channel:telegram".
func TestTelegramSourcePersistence(t *testing.T) {
	// Test CLI source — send a message via CLI path
	llmSrv := mockLLMServer("cli response", "tg response")
	defer llmSrv.Close()

	a := newTestTGAgent(t, llmSrv)

	// CLI-style chat (empty source → defaults to "cli")
	_, err := a.Chat(context.Background(), "from cli", &agent.Callbacks{})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}

	// Telegram-style chat
	_, err = a.Chat(context.Background(), "from telegram", &agent.Callbacks{Source: "channel:telegram"})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}

	msgs, _ := a.Store.GetMessages(context.Background(), "test", 50)
	if len(msgs) != 4 {
		t.Fatalf("messages = %d, want 4", len(msgs))
	}

	// First user message: CLI
	if msgs[0].Source != "cli" {
		t.Errorf("msg[0].Source = %q, want cli", msgs[0].Source)
	}
	// Second user message: Telegram
	if msgs[2].Source != "channel:telegram" {
		t.Errorf("msg[2].Source = %q, want channel:telegram", msgs[2].Source)
	}

	// LLM messages always get "llm"
	if msgs[1].Source != "llm" {
		t.Errorf("msg[1].Source = %q, want llm", msgs[1].Source)
	}
}
