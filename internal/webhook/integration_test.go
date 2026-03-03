package webhook

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"smithly.dev/internal/agent"
	"smithly.dev/internal/db"
	"smithly.dev/internal/db/sqlite"
	"smithly.dev/internal/testutil"
	"smithly.dev/internal/workspace"
)

// TestWebhookIntegration is an end-to-end test: webhook server receives a POST,
// logs the delivery, routes it to an agent that processes the payload via the
// full LLM agent loop (tool call → result → final response), and verifies
// everything was persisted correctly with semi-trusted trust level.
func TestWebhookIntegration(t *testing.T) {
	// 1. Set up real SQLite store
	store, err := sqlite.New(":memory:")
	if err != nil {
		t.Fatalf("create store: %v", err)
	}
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { store.Close() })

	// 2. Mock LLM server — first call triggers echo_tool, second returns summary
	llmCalls := 0
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		llmCalls++
		w.Header().Set("Content-Type", "application/json")

		if llmCalls == 1 {
			// First call: LLM decides to use echo_tool to process the webhook payload
			json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{
					{"message": map[string]any{
						"tool_calls": []map[string]any{
							{
								"id":   "call_1",
								"type": "function",
								"function": map[string]string{
									"name":      "echo_tool",
									"arguments": `{"text":"webhook received: push to main"}`,
								},
							},
						},
					}},
				},
			})
		} else {
			// Second call: LLM returns a summary response
			json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{
					{"message": map[string]any{
						"content": "Webhook processed: push event on refs/heads/main",
					}},
				},
			})
		}
	}))
	defer llm.Close()

	// 3. Create agent in DB and build agent instance
	if err := store.CreateAgent(context.Background(), &db.Agent{
		ID: "coder", Model: "test-model", WorkspacePath: "workspaces/test/",
	}); err != nil {
		t.Fatalf("create agent: %v", err)
	}

	ws := &workspace.Workspace{
		Identity: workspace.Identity{Name: "WebhookBot"},
	}
	a := agent.New(agent.Config{
		ID: "coder", Model: "test-model",
		BaseURL: llm.URL, APIKey: "test-key",
		Workspace: ws, Store: store, Client: llm.Client(),
	})
	a.Tools.Register(&testutil.EchoTool{})

	// 4. Build webhook server with real store and real agent
	agentMap := &simpleAgentGetter{agents: map[string]*agent.Agent{"coder": a}}
	secret := "integration-secret"

	whServer := &Server{
		Bind: "127.0.0.1",
		Port: 0,
		Webhooks: map[string]*WebhookConfig{
			"github": {Name: "github", Secret: secret, AgentID: "coder", AutoApprove: true},
			"open":   {Name: "open", AgentID: "coder", AutoApprove: true},
		},
		Store:  store,
		Agents: agentMap,
	}

	// 5. Start webhook server on ephemeral port
	ts := httptest.NewServer(whServer.Handler())
	defer ts.Close()

	// --- Test: Full round-trip with valid HMAC ---
	t.Run("FullRoundTrip", func(t *testing.T) {
		payload := []byte(`{"action":"push","ref":"refs/heads/main"}`)
		sig := computeHMAC(payload, secret)

		req, _ := http.NewRequest("POST", ts.URL+"/w/github", bytes.NewReader(payload))
		req.Header.Set("X-Hub-Signature-256", sig)
		req.Header.Set("Content-Type", "application/json")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
		}

		var result map[string]string
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if result["status"] != "accepted" {
			t.Errorf("response status = %q, want accepted", result["status"])
		}

		// Wait for async agent processing to complete
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			msgs, _ := store.GetMessages(context.Background(), "coder", 50)
			if len(msgs) >= 2 { // user + assistant
				break
			}
			time.Sleep(100 * time.Millisecond)
		}

		// Verify webhook log entry
		entries, err := store.ListWebhookLog(context.Background(), "github", 10)
		if err != nil {
			t.Fatalf("ListWebhookLog: %v", err)
		}
		if len(entries) == 0 {
			t.Fatal("expected at least 1 webhook log entry")
		}
		entry := entries[0]
		if !entry.SignatureValid {
			t.Error("expected SignatureValid=true")
		}
		if entry.Body != string(payload) {
			t.Errorf("logged body = %q, want %q", entry.Body, string(payload))
		}
		if entry.AgentID != "coder" {
			t.Errorf("agent_id = %q, want coder", entry.AgentID)
		}

		// Verify LLM was called (2 calls: tool call + final response)
		if llmCalls != 2 {
			t.Errorf("LLM calls = %d, want 2", llmCalls)
		}

		// Verify messages persisted with correct source + trust
		msgs, err := store.GetMessages(context.Background(), "coder", 50)
		if err != nil {
			t.Fatalf("GetMessages: %v", err)
		}
		if len(msgs) < 2 {
			t.Fatalf("messages = %d, want at least 2 (user + assistant)", len(msgs))
		}

		// User message should have webhook source and semi-trusted
		userMsg := msgs[0]
		if userMsg.Role != "user" {
			t.Errorf("msg[0].Role = %q, want user", userMsg.Role)
		}
		if userMsg.Source != "webhook:github" {
			t.Errorf("msg[0].Source = %q, want webhook:github", userMsg.Source)
		}
		if userMsg.Trust != "semi-trusted" {
			t.Errorf("msg[0].Trust = %q, want semi-trusted", userMsg.Trust)
		}
		if !strings.Contains(userMsg.Content, "push") {
			t.Errorf("msg[0].Content should contain webhook payload, got %q", userMsg.Content)
		}

		// Assistant message should contain the processed response
		assistantMsg := msgs[1]
		if assistantMsg.Role != "assistant" {
			t.Errorf("msg[1].Role = %q, want assistant", assistantMsg.Role)
		}
		if !strings.Contains(assistantMsg.Content, "push event") {
			t.Errorf("msg[1].Content = %q, expected summary of webhook", assistantMsg.Content)
		}

		// Verify audit log has tool_call + llm_chat entries
		auditEntries, err := store.GetAuditLog(context.Background(), db.AuditQuery{AgentID: "coder"})
		if err != nil {
			t.Fatalf("GetAuditLog: %v", err)
		}
		var hasToolCall, hasLLMChat bool
		for _, e := range auditEntries {
			if e.Action == "tool_call" && e.Target == "echo_tool" {
				hasToolCall = true
			}
			if e.Action == "llm_chat" {
				hasLLMChat = true
			}
		}
		if !hasToolCall {
			t.Error("missing tool_call audit entry for echo_tool")
		}
		if !hasLLMChat {
			t.Error("missing llm_chat audit entry")
		}

		fmt.Printf("Webhook integration: %d LLM calls, %d messages, %d audit entries\n",
			llmCalls, len(msgs), len(auditEntries))
	})

	// --- Test: Invalid HMAC returns 401 but still logs ---
	t.Run("InvalidSignature", func(t *testing.T) {
		payload := []byte(`{"action":"opened"}`)
		req, _ := http.NewRequest("POST", ts.URL+"/w/github", bytes.NewReader(payload))
		req.Header.Set("X-Hub-Signature-256", "sha256=0000000000000000000000000000000000000000000000000000000000000000")

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", resp.StatusCode)
		}

		// Should still be logged for audit
		entries, _ := store.ListWebhookLog(context.Background(), "github", 10)
		found := false
		for _, e := range entries {
			if e.Body == string(payload) && !e.SignatureValid {
				found = true
				break
			}
		}
		if !found {
			t.Error("failed signature delivery should still be logged")
		}
	})

	// --- Test: No-secret webhook accepts anything ---
	t.Run("NoSecretWebhook", func(t *testing.T) {
		payload := []byte(`{"type":"charge.succeeded"}`)
		req, _ := http.NewRequest("POST", ts.URL+"/w/open", bytes.NewReader(payload))

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST: %v", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
		}
	})

	// --- Test: Unknown webhook returns 404 ---
	t.Run("UnknownWebhook", func(t *testing.T) {
		req, _ := http.NewRequest("POST", ts.URL+"/w/nope", bytes.NewReader([]byte("{}")))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST: %v", err)
		}
		resp.Body.Close()

		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", resp.StatusCode)
		}
	})

	// --- Test: Health check ---
	t.Run("HealthCheck", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/health")
		if err != nil {
			t.Fatalf("GET /health: %v", err)
		}
		resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
	})
}

// simpleAgentGetter is a test helper implementing channels.AgentGetter.
type simpleAgentGetter struct {
	agents map[string]*agent.Agent
}

func (g *simpleAgentGetter) GetAgent(id string) (*agent.Agent, bool) {
	a, ok := g.agents[id]
	return a, ok
}
