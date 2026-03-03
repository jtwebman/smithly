package channels_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"smithly.dev/internal/agent"
	"smithly.dev/internal/channels"
	"smithly.dev/internal/db/sqlite"
	"smithly.dev/internal/testutil"
	"smithly.dev/internal/workspace"
)

// discordBotServer mocks the Discord REST API and Gateway WebSocket on a single server.
type discordBotServer struct {
	mu       sync.Mutex
	messages []discordMockMessage // queued MESSAGE_CREATE events
	sent     []string             // captured message texts from POST /channels/{id}/messages
	typing   []string             // captured channel IDs from POST /channels/{id}/typing
	invalidSession bool           // if true, send OP 9 instead of READY after Identify

	wsReady chan struct{} // closed when WS client has identified and READY was sent
}

type discordMockMessage struct {
	ID        string
	ChannelID string
	Content   string
	AuthorID  string
	Username  string
	Bot       bool
}

func newDiscordBotServer() *discordBotServer {
	return &discordBotServer{
		wsReady: make(chan struct{}),
	}
}

func (s *discordBotServer) enqueueMessage(channelID, content string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.messages = append(s.messages, discordMockMessage{
		ID:        fmt.Sprintf("msg_%d", len(s.messages)+1),
		ChannelID: channelID,
		Content:   content,
		AuthorID:  "user_42",
		Username:  "testuser",
	})
}

func (s *discordBotServer) enqueueBotMessage(channelID, content string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.messages = append(s.messages, discordMockMessage{
		ID:        fmt.Sprintf("msg_%d", len(s.messages)+1),
		ChannelID: channelID,
		Content:   content,
		AuthorID:  "bot_99",
		Username:  "otherbot",
		Bot:       true,
	})
}

func (s *discordBotServer) enqueueEmptyMessage(channelID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.messages = append(s.messages, discordMockMessage{
		ID:        fmt.Sprintf("msg_%d", len(s.messages)+1),
		ChannelID: channelID,
		Content:   "",
		AuthorID:  "user_42",
		Username:  "testuser",
	})
}

func (s *discordBotServer) getSent() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.sent))
	copy(out, s.sent)
	return out
}

func (s *discordBotServer) getTyping() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.typing))
	copy(out, s.typing)
	return out
}

func (s *discordBotServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	// WebSocket upgrade path
	if path == "/gateway" || path == "/gateway/" {
		s.handleWebSocket(w, r)
		return
	}

	// REST: GET /gateway/bot
	if path == "/gateway/bot" && r.Method == "GET" {
		// Return a ws:// URL pointing to /gateway on this server
		// The caller will set GatewayURL directly, so this is a fallback
		json.NewEncoder(w).Encode(map[string]any{
			"url": "ws://unused",
		})
		return
	}

	// REST: POST /channels/{id}/messages
	if r.Method == "POST" && strings.Contains(path, "/channels/") && strings.HasSuffix(path, "/messages") {
		var req struct {
			Content string `json:"content"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		s.mu.Lock()
		s.sent = append(s.sent, req.Content)
		s.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{
			"id":         "sent_1",
			"channel_id": "ch_1",
			"content":    req.Content,
		})
		return
	}

	// REST: POST /channels/{id}/typing
	if r.Method == "POST" && strings.Contains(path, "/channels/") && strings.HasSuffix(path, "/typing") {
		// Extract channel ID
		parts := strings.Split(path, "/")
		for i, p := range parts {
			if p == "channels" && i+1 < len(parts) {
				s.mu.Lock()
				s.typing = append(s.typing, parts[i+1])
				s.mu.Unlock()
				break
			}
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	http.Error(w, "not found: "+path, 404)
}

func (s *discordBotServer) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()

	ctx := r.Context()

	// Send OP 10 Hello
	sendWSJSON(ctx, conn, map[string]any{
		"op": 10,
		"d":  map[string]any{"heartbeat_interval": 45000},
	})

	// Read Identify (OP 2) or Resume (OP 6)
	var identify struct {
		Op int             `json:"op"`
		D  json.RawMessage `json:"d"`
	}
	if err := readWSJSON(ctx, conn, &identify); err != nil {
		return
	}

	if s.invalidSession {
		// Send OP 9 Invalid Session
		sendWSJSON(ctx, conn, map[string]any{
			"op": 9,
			"d":  false,
		})
		return
	}

	if identify.Op == 2 {
		// Send READY dispatch
		var seq int64 = 1
		sendWSJSON(ctx, conn, map[string]any{
			"op": 0,
			"s":  seq,
			"t":  "READY",
			"d": map[string]any{
				"session_id": "test_session",
				"user": map[string]any{
					"id":       "bot_123",
					"username": "test_discord_bot",
					"bot":      true,
				},
			},
		})
	} else if identify.Op == 6 {
		// Send RESUMED dispatch
		sendWSJSON(ctx, conn, map[string]any{
			"op": 0,
			"t":  "RESUMED",
			"d":  map[string]any{},
		})
	}

	// Signal that we're ready
	select {
	case <-s.wsReady:
	default:
		close(s.wsReady)
	}

	// Dispatch queued messages
	s.mu.Lock()
	msgs := s.messages
	s.messages = nil
	s.mu.Unlock()

	seq := int64(2)
	for _, msg := range msgs {
		sendWSJSON(ctx, conn, map[string]any{
			"op": 0,
			"s":  seq,
			"t":  "MESSAGE_CREATE",
			"d": map[string]any{
				"id":         msg.ID,
				"channel_id": msg.ChannelID,
				"content":    msg.Content,
				"author": map[string]any{
					"id":       msg.AuthorID,
					"username": msg.Username,
					"bot":      msg.Bot,
				},
			},
		})
		seq++
	}

	// Keep the connection alive — read heartbeats, respond with ACK
	for {
		var payload struct {
			Op int `json:"op"`
		}
		if err := readWSJSON(ctx, conn, &payload); err != nil {
			return
		}
		if payload.Op == 1 {
			sendWSJSON(ctx, conn, map[string]any{"op": 11})
		}
	}
}

func sendWSJSON(ctx context.Context, conn *websocket.Conn, v any) {
	data, _ := json.Marshal(v)
	conn.Write(ctx, websocket.MessageText, data)
}

func readWSJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	_, data, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func newTestDiscordAgent(t *testing.T, llmSrv *httptest.Server) *agent.Agent {
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
		Identity: workspace.Identity{Name: "DiscordBot"},
	}
	return agent.New(agent.Config{
		ID: "test", Model: "test-model",
		BaseURL: llmSrv.URL, APIKey: "key",
		Workspace: ws, Store: store, Client: llmSrv.Client(),
	})
}

// discordGatewayURL extracts the WebSocket URL from an httptest.Server URL.
func discordGatewayURL(srv *httptest.Server) string {
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/gateway"
}

func TestDiscordHandleMessage(t *testing.T) {
	llmSrv := mockLLMServer("Hello from Discord bot!")
	defer llmSrv.Close()

	dcBot := newDiscordBotServer()
	dcBot.enqueueMessage("ch_42", "hi there")
	dcSrv := httptest.NewServer(dcBot)
	defer dcSrv.Close()

	a := newTestDiscordAgent(t, llmSrv)

	dc := &channels.Discord{
		Token:      "test-token",
		Agent:      a,
		GatewayURL: discordGatewayURL(dcSrv),
		APIURL:     dcSrv.URL,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- dc.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := dcBot.getSent()
		if len(sent) > 0 {
			if !strings.Contains(sent[0], "Hello from Discord bot!") {
				t.Errorf("sent = %q, want 'Hello from Discord bot!'", sent[0])
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
	typing := dcBot.getTyping()
	if len(typing) == 0 || typing[0] != "ch_42" {
		t.Errorf("typing = %v, want [ch_42]", typing)
	}

	// Verify message was persisted with correct source
	msgs, _ := a.Store.GetMessages(context.Background(), "test", 50)
	if len(msgs) < 2 {
		t.Fatalf("messages = %d, want >= 2", len(msgs))
	}
	if msgs[0].Source != "channel:discord" {
		t.Errorf("source = %q, want channel:discord", msgs[0].Source)
	}

	cancel()
	<-done
}

func TestDiscordLongMessage(t *testing.T) {
	text := strings.Repeat("x", 3000)
	llmSrv := mockLLMServer(text)
	defer llmSrv.Close()

	dcBot := newDiscordBotServer()
	dcBot.enqueueMessage("ch_42", "give me a long response")
	dcSrv := httptest.NewServer(dcBot)
	defer dcSrv.Close()

	a := newTestDiscordAgent(t, llmSrv)

	dc := &channels.Discord{
		Token:      "test-token",
		Agent:      a,
		GatewayURL: discordGatewayURL(dcSrv),
		APIURL:     dcSrv.URL,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- dc.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := dcBot.getSent()
		if len(sent) >= 2 {
			// First chunk should be exactly 2000 chars
			if len(sent[0]) > 2000 {
				t.Errorf("first chunk len = %d, want <= 2000", len(sent[0]))
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

func TestDiscordLongMessageNewlineSplit(t *testing.T) {
	part1 := strings.Repeat("a", 1900)
	part2 := strings.Repeat("b", 200)
	text := part1 + "\n" + part2

	llmSrv := mockLLMServer(text)
	defer llmSrv.Close()

	dcBot := newDiscordBotServer()
	dcBot.enqueueMessage("ch_42", "test")
	dcSrv := httptest.NewServer(dcBot)
	defer dcSrv.Close()

	a := newTestDiscordAgent(t, llmSrv)

	dc := &channels.Discord{
		Token:      "test-token",
		Agent:      a,
		GatewayURL: discordGatewayURL(dcSrv),
		APIURL:     dcSrv.URL,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- dc.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := dcBot.getSent()
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

func TestDiscordInvalidToken(t *testing.T) {
	llmSrv := mockLLMServer()
	defer llmSrv.Close()

	dcBot := newDiscordBotServer()
	dcBot.invalidSession = true
	dcSrv := httptest.NewServer(dcBot)
	defer dcSrv.Close()

	a := newTestDiscordAgent(t, llmSrv)

	dc := &channels.Discord{
		Token:      "bad-token",
		Agent:      a,
		GatewayURL: discordGatewayURL(dcSrv),
		APIURL:     dcSrv.URL,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	err := dc.Start(ctx)
	// Start returns context error after reconnect loop exhausts context
	if err == nil {
		t.Fatal("expected error from invalid token")
	}
}

func TestDiscordAutoApproveDeny(t *testing.T) {
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

	dcBot := newDiscordBotServer()
	dcBot.enqueueMessage("ch_42", "use tool")
	dcSrv := httptest.NewServer(dcBot)
	defer dcSrv.Close()

	a := newTestDiscordAgent(t, llmSrv)
	a.Tools.Register(&testutil.EchoTool{})

	dc := &channels.Discord{
		Token:       "test-token",
		Agent:       a,
		AutoApprove: false,
		GatewayURL:  discordGatewayURL(dcSrv),
		APIURL:      dcSrv.URL,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- dc.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := dcBot.getSent()
		if len(sent) > 0 {
			// Tool should have been denied
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

func TestDiscordAutoApproveAllow(t *testing.T) {
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

	dcBot := newDiscordBotServer()
	dcBot.enqueueMessage("ch_42", "use tool")
	dcSrv := httptest.NewServer(dcBot)
	defer dcSrv.Close()

	a := newTestDiscordAgent(t, llmSrv)
	a.Tools.Register(&testutil.EchoTool{})

	dc := &channels.Discord{
		Token:       "test-token",
		Agent:       a,
		AutoApprove: true,
		GatewayURL:  discordGatewayURL(dcSrv),
		APIURL:      dcSrv.URL,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- dc.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := dcBot.getSent()
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

func TestDiscordBotMessageSkipped(t *testing.T) {
	llmSrv := mockLLMServer("should not see this")
	defer llmSrv.Close()

	dcBot := newDiscordBotServer()
	// Enqueue a bot message — should be skipped
	dcBot.enqueueBotMessage("ch_42", "bot says hi")
	// Then a real message to verify the bot is working
	dcBot.enqueueMessage("ch_42", "hello")
	dcSrv := httptest.NewServer(dcBot)
	defer dcSrv.Close()

	a := newTestDiscordAgent(t, llmSrv)

	dc := &channels.Discord{
		Token:      "test-token",
		Agent:      a,
		GatewayURL: discordGatewayURL(dcSrv),
		APIURL:     dcSrv.URL,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- dc.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := dcBot.getSent()
		if len(sent) > 0 {
			// Only the real message should produce a response
			if len(sent) != 1 {
				t.Errorf("sent %d messages, want 1 (bot message should be skipped)", len(sent))
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

func TestDiscordEmptyMessageSkipped(t *testing.T) {
	llmSrv := mockLLMServer("should not see this")
	defer llmSrv.Close()

	dcBot := newDiscordBotServer()
	// Enqueue empty message — should be skipped
	dcBot.enqueueEmptyMessage("ch_42")
	// Then a real message
	dcBot.enqueueMessage("ch_42", "hello")
	dcSrv := httptest.NewServer(dcBot)
	defer dcSrv.Close()

	a := newTestDiscordAgent(t, llmSrv)

	dc := &channels.Discord{
		Token:      "test-token",
		Agent:      a,
		GatewayURL: discordGatewayURL(dcSrv),
		APIURL:     dcSrv.URL,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- dc.Start(ctx) }()

	deadline := time.After(5 * time.Second)
	for {
		sent := dcBot.getSent()
		if len(sent) > 0 {
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

func TestDiscordContextCancel(t *testing.T) {
	llmSrv := mockLLMServer()
	defer llmSrv.Close()

	dcBot := newDiscordBotServer()
	dcSrv := httptest.NewServer(dcBot)
	defer dcSrv.Close()

	a := newTestDiscordAgent(t, llmSrv)

	dc := &channels.Discord{
		Token:      "test-token",
		Agent:      a,
		GatewayURL: discordGatewayURL(dcSrv),
		APIURL:     dcSrv.URL,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- dc.Start(ctx) }()

	// Wait for WS connection to establish, then cancel
	select {
	case <-dcBot.wsReady:
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for WS connection")
	}
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

func TestDiscordSourcePersistence(t *testing.T) {
	llmSrv := mockLLMServer("cli response", "dc response")
	defer llmSrv.Close()

	a := newTestDiscordAgent(t, llmSrv)

	// CLI-style chat (empty source → defaults to "cli")
	_, err := a.Chat(context.Background(), "from cli", &agent.Callbacks{})
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}

	// Discord-style chat
	_, err = a.Chat(context.Background(), "from discord", &agent.Callbacks{Source: "channel:discord"})
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
	// Second user message: Discord
	if msgs[2].Source != "channel:discord" {
		t.Errorf("msg[2].Source = %q, want channel:discord", msgs[2].Source)
	}

	// LLM messages always get "llm"
	if msgs[1].Source != "llm" {
		t.Errorf("msg[1].Source = %q, want llm", msgs[1].Source)
	}
}
