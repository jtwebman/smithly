package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"smithly.dev/internal/agent"
	"smithly.dev/internal/db"
	"smithly.dev/internal/db/sqlite"
	"smithly.dev/internal/testutil"
	"smithly.dev/internal/workspace"
)

// TestFullStackSmoke tests the core agent loop end-to-end:
// mock LLM → tool call → tool execution → final response → DB persistence.
func TestFullStackSmoke(t *testing.T) {
	// 1. Start mock LLM server
	callCount := 0
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")

		if callCount == 1 {
			// First call: LLM requests echo_tool
			json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{
					{"message": map[string]any{
						"tool_calls": []map[string]any{
							{
								"id":   "call_1",
								"type": "function",
								"function": map[string]string{
									"name":      "echo_tool",
									"arguments": `{"text":"integration"}`,
								},
							},
						},
					}},
				},
			})
		} else {
			// Second call: LLM returns final text incorporating tool result
			json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{
					{"message": map[string]any{
						"content": "The tool said: echoed: integration",
					}},
				},
			})
		}
	}))
	defer llm.Close()

	// 2. Create in-memory SQLite store + migrate
	store, err := sqlite.New(":memory:")
	if err != nil {
		t.Fatalf("create store: %v", err)
	}
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { store.Close() })

	// 3. Build agent via agent.New()
	ws := &workspace.Workspace{
		Identity: workspace.Identity{Name: "IntegrationBot"},
	}
	a := agent.New(agent.Config{
		ID: "int-test", Model: "test-model",
		BaseURL: llm.URL, APIKey: "test-key",
		Workspace: ws, Store: store, Client: llm.Client(),
	})

	// 4. Register echo tool
	a.Tools.Register(&testutil.EchoTool{})

	// 5. Call Chat() with a message that triggers the tool
	var toolCallName, toolResult string
	cb := &agent.Callbacks{
		OnToolCall:   func(name, args string) { toolCallName = name },
		OnToolResult: func(name, result string) { toolResult = result },
	}

	result, err := a.Chat(context.Background(), "please echo integration", cb)
	if err != nil {
		t.Fatalf("Chat: %v", err)
	}

	// 6. Verify response
	if result != "The tool said: echoed: integration" {
		t.Errorf("result = %q, want %q", result, "The tool said: echoed: integration")
	}
	if toolCallName != "echo_tool" {
		t.Errorf("tool call name = %q, want echo_tool", toolCallName)
	}
	if toolResult != "echoed: integration" {
		t.Errorf("tool result = %q, want %q", toolResult, "echoed: integration")
	}

	// Verify 2 LLM round-trips (initial + after tool result)
	if callCount != 2 {
		t.Errorf("LLM calls = %d, want 2", callCount)
	}

	// Verify messages were persisted in DB
	msgs, err := store.GetMessages(context.Background(), "int-test", 50)
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("messages = %d, want 2 (user + assistant)", len(msgs))
	}
	if msgs[0].Role != "user" || !strings.Contains(msgs[0].Content, "echo integration") {
		t.Errorf("msg[0] = %q/%q", msgs[0].Role, msgs[0].Content)
	}
	if msgs[1].Role != "assistant" || !strings.Contains(msgs[1].Content, "echoed: integration") {
		t.Errorf("msg[1] = %q/%q", msgs[1].Role, msgs[1].Content)
	}

	// Verify audit entries
	entries, err := store.GetAuditLog(context.Background(), db.AuditQuery{})
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	var hasToolCall, hasLLMChat bool
	for _, e := range entries {
		if e.Action == "tool_call" && e.Target == "echo_tool" {
			hasToolCall = true
		}
		if e.Action == "llm_chat" {
			hasLLMChat = true
		}
	}
	if !hasToolCall {
		t.Error("missing tool_call audit entry")
	}
	if !hasLLMChat {
		t.Error("missing llm_chat audit entry")
	}

	fmt.Printf("Integration test passed: %d LLM calls, %d messages persisted, %d audit entries\n",
		callCount, len(msgs), len(entries))
}
