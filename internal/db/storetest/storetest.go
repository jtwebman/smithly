// Package storetest provides a shared conformance test suite for db.Store implementations.
// Any backend (SQLite, Postgres, MongoDB, etc.) imports this package and calls
// RunAll(t, factory) to verify it satisfies the Store contract.
package storetest

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"smithly.dev/internal/db"
)

// Factory creates a fresh, empty, migrated Store for each test.
type Factory func(t *testing.T) db.Store

// RunAll runs the full conformance suite against the given factory.
func RunAll(t *testing.T, factory Factory) {
	t.Helper()

	tests := []struct {
		name string
		fn   func(*testing.T, db.Store)
	}{
		{"CreateAndGetAgent", testCreateAndGetAgent},
		{"ListAgents", testListAgents},
		{"DeleteAgent", testDeleteAgent},
		{"AgentNotFound", testAgentNotFound},
		{"DuplicateAgent", testDuplicateAgent},
		{"AppendAndGetMessages", testAppendAndGetMessages},
		{"GetMessagesLimit", testGetMessagesLimit},
		{"MessagesIsolatedPerAgent", testMessagesIsolatedPerAgent},
		{"MessagesChronologicalOrder", testMessagesChronologicalOrder},
		{"AuditLog", testAuditLog},
		{"AuditFilterByAgent", testAuditFilterByAgent},
		{"AuditFilterByDomain", testAuditFilterByDomain},
		{"DomainSetAndGet", testDomainSetAndGet},
		{"DomainList", testDomainList},
		{"DomainTouch", testDomainTouch},
		{"DomainNotFound", testDomainNotFound},
		{"DomainUpsert", testDomainUpsert},
		{"SearchMessages", testSearchMessages},
		{"SearchMessagesFTS", testSearchMessagesFTS},
		{"InsertSummary", testInsertSummary},
		{"StoreAndGetEmbeddings", testStoreAndGetEmbeddings},
		{"GetEmbeddingCount", testGetEmbeddingCount},
		{"GetUnembeddedMessages", testGetUnembeddedMessages},
		{"FTSTriggerSync", testFTSTriggerSync},
		{"GetMessagesByID", testGetMessagesByID},
		{"GetMessagesByIDs", testGetMessagesByIDs},
		{"AppendMessageSetsID", testAppendMessageSetsID},
		{"MigrateIdempotent", testMigrateIdempotent},
		{"CreateAndListBindings", testCreateAndListBindings},
		{"DeleteBinding", testDeleteBinding},
		{"ResolveBindingExactContact", testResolveBindingExactContact},
		{"ResolveBindingChannelFallback", testResolveBindingChannelFallback},
		{"ResolveBindingWildcard", testResolveBindingWildcard},
		{"ResolveBindingNotFound", testResolveBindingNotFound},
		{"ResolveBindingPriority", testResolveBindingPriority},
		{"LogAndListWebhooks", testLogAndListWebhooks},
		{"ListWebhooksFilterByName", testListWebhooksFilterByName},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := factory(t)
			tt.fn(t, store)
		})
	}
}

// --- Agent Tests ---

func testCreateAndGetAgent(t *testing.T, store db.Store) {
	ctx := context.Background()
	agent := &db.Agent{
		ID:            "test-agent",
		Model:         "gpt-4o",
		WorkspacePath: "workspaces/test/",
	}

	if err := store.CreateAgent(ctx, agent); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	got, err := store.GetAgent(ctx, "test-agent")
	if err != nil {
		t.Fatalf("GetAgent: %v", err)
	}
	if got.ID != "test-agent" {
		t.Errorf("ID = %q, want %q", got.ID, "test-agent")
	}
	if got.Model != "gpt-4o" {
		t.Errorf("Model = %q, want %q", got.Model, "gpt-4o")
	}
	if got.WorkspacePath != "workspaces/test/" {
		t.Errorf("WorkspacePath = %q, want %q", got.WorkspacePath, "workspaces/test/")
	}
	if got.CreatedAt.IsZero() {
		t.Error("CreatedAt should not be zero")
	}
}

func testListAgents(t *testing.T, store db.Store) {
	ctx := context.Background()

	agents := []*db.Agent{
		{ID: "a1", Model: "gpt-4o", WorkspacePath: "ws/a1"},
		{ID: "a2", Model: "claude-sonnet", WorkspacePath: "ws/a2"},
		{ID: "a3", Model: "llama3.2", WorkspacePath: "ws/a3"},
	}
	for _, a := range agents {
		if err := store.CreateAgent(ctx, a); err != nil {
			t.Fatalf("CreateAgent %s: %v", a.ID, err)
		}
	}

	list, err := store.ListAgents(ctx)
	if err != nil {
		t.Fatalf("ListAgents: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("len = %d, want 3", len(list))
	}
}

func testDeleteAgent(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "del", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	if err := store.DeleteAgent(ctx, "del"); err != nil {
		t.Fatalf("DeleteAgent: %v", err)
	}

	_, err := store.GetAgent(ctx, "del")
	if err == nil {
		t.Fatal("expected error after delete, got nil")
	}
}

func testAgentNotFound(t *testing.T, store db.Store) {
	ctx := context.Background()
	_, err := store.GetAgent(ctx, "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent agent, got nil")
	}
	if !errors.Is(err, db.ErrNotFound) {
		t.Errorf("expected db.ErrNotFound, got %v", err)
	}
}

func testDuplicateAgent(t *testing.T, store db.Store) {
	ctx := context.Background()
	a := &db.Agent{ID: "dup", Model: "m", WorkspacePath: "w"}
	if err := store.CreateAgent(ctx, a); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	err := store.CreateAgent(ctx, a)
	if err == nil {
		t.Fatal("expected error for duplicate agent, got nil")
	}
}

// --- Memory Tests ---

func testAppendAndGetMessages(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	msgs := []*db.Message{
		{AgentID: "agent1", Role: "user", Content: "hello", Source: "cli", Trust: "trusted"},
		{AgentID: "agent1", Role: "assistant", Content: "hi there", Source: "llm", Trust: "trusted"},
		{AgentID: "agent1", Role: "user", Content: "how are you?", Source: "cli", Trust: "trusted"},
	}
	for _, m := range msgs {
		if err := store.AppendMessage(ctx, m); err != nil {
			t.Fatalf("AppendMessage: %v", err)
		}
	}

	got, err := store.GetMessages(ctx, "agent1", 10)
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}
	if got[0].Content != "hello" {
		t.Errorf("first message = %q, want %q", got[0].Content, "hello")
	}
	if got[1].Role != "assistant" {
		t.Errorf("second role = %q, want %q", got[1].Role, "assistant")
	}
	if got[2].Content != "how are you?" {
		t.Errorf("last message = %q, want %q", got[2].Content, "how are you?")
	}
}

func testGetMessagesLimit(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	for i := range 10 {
		if err := store.AppendMessage(ctx, &db.Message{
			AgentID: "agent1", Role: "user",
			Content: fmt.Sprintf("msg %d", i),
			Source:  "cli", Trust: "trusted",
		}); err != nil {
			t.Fatalf("AppendMessage %d: %v", i, err)
		}
	}

	got, err := store.GetMessages(ctx, "agent1", 3)
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}
	// Should be the 3 most recent, in chronological order
	if got[0].Content != "msg 7" {
		t.Errorf("first = %q, want %q", got[0].Content, "msg 7")
	}
	if got[2].Content != "msg 9" {
		t.Errorf("last = %q, want %q", got[2].Content, "msg 9")
	}
}

func testMessagesIsolatedPerAgent(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "a1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	if err := store.CreateAgent(ctx, &db.Agent{ID: "a2", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	if err := store.AppendMessage(ctx, &db.Message{AgentID: "a1", Role: "user", Content: "for a1", Source: "cli", Trust: "trusted"}); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}
	if err := store.AppendMessage(ctx, &db.Message{AgentID: "a1", Role: "user", Content: "also a1", Source: "cli", Trust: "trusted"}); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}
	if err := store.AppendMessage(ctx, &db.Message{AgentID: "a2", Role: "user", Content: "for a2", Source: "cli", Trust: "trusted"}); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}

	msgs1, _ := store.GetMessages(ctx, "a1", 10)
	if len(msgs1) != 2 {
		t.Fatalf("a1 messages = %d, want 2", len(msgs1))
	}

	msgs2, _ := store.GetMessages(ctx, "a2", 10)
	if len(msgs2) != 1 {
		t.Fatalf("a2 messages = %d, want 1", len(msgs2))
	}
	if msgs2[0].Content != "for a2" {
		t.Errorf("a2 content = %q, want %q", msgs2[0].Content, "for a2")
	}
}

func testMessagesChronologicalOrder(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	for i := range 5 {
		if err := store.AppendMessage(ctx, &db.Message{
			AgentID: "agent1", Role: "user",
			Content: fmt.Sprintf("msg %d", i),
			Source:  "cli", Trust: "trusted",
		}); err != nil {
			t.Fatalf("AppendMessage %d: %v", i, err)
		}
	}

	got, _ := store.GetMessages(ctx, "agent1", 100)
	for i := 1; i < len(got); i++ {
		if got[i].ID <= got[i-1].ID {
			t.Errorf("messages not in order: id %d <= %d", got[i].ID, got[i-1].ID)
		}
	}
}

// --- Audit Tests ---

func testAuditLog(t *testing.T, store db.Store) {
	ctx := context.Background()

	entries := []*db.AuditEntry{
		{Actor: "agent:bot1", Action: "llm_chat", TrustLevel: "trusted"},
		{Actor: "skill:weather", Action: "http_get", TrustLevel: "trusted", Domain: "api.weather.com"},
		{Actor: "agent:bot1", Action: "llm_chat", TrustLevel: "trusted"},
	}
	for _, e := range entries {
		if err := store.LogAudit(ctx, e); err != nil {
			t.Fatalf("LogAudit: %v", err)
		}
	}

	all, err := store.GetAuditLog(ctx, db.AuditQuery{Limit: 10})
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("len = %d, want 3", len(all))
	}
}

func testAuditFilterByAgent(t *testing.T, store db.Store) {
	ctx := context.Background()

	if err := store.LogAudit(ctx, &db.AuditEntry{Actor: "agent:bot1", Action: "llm_chat", TrustLevel: "trusted"}); err != nil {
		t.Fatalf("LogAudit: %v", err)
	}
	if err := store.LogAudit(ctx, &db.AuditEntry{Actor: "agent:bot2", Action: "llm_chat", TrustLevel: "trusted"}); err != nil {
		t.Fatalf("LogAudit: %v", err)
	}
	if err := store.LogAudit(ctx, &db.AuditEntry{Actor: "agent:bot1", Action: "tool_call", TrustLevel: "trusted"}); err != nil {
		t.Fatalf("LogAudit: %v", err)
	}

	got, err := store.GetAuditLog(ctx, db.AuditQuery{AgentID: "bot1", Limit: 10})
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("filtered len = %d, want 2", len(got))
	}
}

func testAuditFilterByDomain(t *testing.T, store db.Store) {
	ctx := context.Background()

	if err := store.LogAudit(ctx, &db.AuditEntry{Actor: "skill:web", Action: "http_get", TrustLevel: "trusted", Domain: "api.example.com"}); err != nil {
		t.Fatalf("LogAudit: %v", err)
	}
	if err := store.LogAudit(ctx, &db.AuditEntry{Actor: "skill:web", Action: "http_get", TrustLevel: "trusted", Domain: "api.other.com"}); err != nil {
		t.Fatalf("LogAudit: %v", err)
	}

	got, err := store.GetAuditLog(ctx, db.AuditQuery{Domain: "api.example.com", Limit: 10})
	if err != nil {
		t.Fatalf("GetAuditLog: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("domain filtered len = %d, want 1", len(got))
	}
}

// --- Domain Tests ---

func testDomainSetAndGet(t *testing.T, store db.Store) {
	ctx := context.Background()

	entry := &db.DomainEntry{
		Domain:    "api.example.com",
		Status:    "allow",
		GrantedBy: "user",
	}
	if err := store.SetDomain(ctx, entry); err != nil {
		t.Fatalf("SetDomain: %v", err)
	}

	got, err := store.GetDomain(ctx, "api.example.com")
	if err != nil {
		t.Fatalf("GetDomain: %v", err)
	}
	if got.Domain != "api.example.com" {
		t.Errorf("Domain = %q, want %q", got.Domain, "api.example.com")
	}
	if got.Status != "allow" {
		t.Errorf("Status = %q, want %q", got.Status, "allow")
	}
	if got.GrantedBy != "user" {
		t.Errorf("GrantedBy = %q, want %q", got.GrantedBy, "user")
	}
	if got.AccessCount != 0 {
		t.Errorf("AccessCount = %d, want 0", got.AccessCount)
	}
}

func testDomainList(t *testing.T, store db.Store) {
	ctx := context.Background()

	domains := []*db.DomainEntry{
		{Domain: "api.a.com", Status: "allow", GrantedBy: "user"},
		{Domain: "api.b.com", Status: "deny", GrantedBy: "user"},
		{Domain: "api.c.com", Status: "allow", GrantedBy: "skill:web"},
	}
	for _, d := range domains {
		if err := store.SetDomain(ctx, d); err != nil {
			t.Fatalf("SetDomain %s: %v", d.Domain, err)
		}
	}

	list, err := store.ListDomains(ctx)
	if err != nil {
		t.Fatalf("ListDomains: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("len = %d, want 3", len(list))
	}
	// Should be ordered alphabetically
	if list[0].Domain != "api.a.com" {
		t.Errorf("first = %q, want %q", list[0].Domain, "api.a.com")
	}
	if list[1].Status != "deny" {
		t.Errorf("second status = %q, want %q", list[1].Status, "deny")
	}
}

func testDomainTouch(t *testing.T, store db.Store) {
	ctx := context.Background()

	if err := store.SetDomain(ctx, &db.DomainEntry{Domain: "api.touch.com", Status: "allow", GrantedBy: "user"}); err != nil {
		t.Fatalf("SetDomain: %v", err)
	}

	// Touch twice
	if err := store.TouchDomain(ctx, "api.touch.com"); err != nil {
		t.Fatalf("TouchDomain: %v", err)
	}
	if err := store.TouchDomain(ctx, "api.touch.com"); err != nil {
		t.Fatalf("TouchDomain: %v", err)
	}

	got, err := store.GetDomain(ctx, "api.touch.com")
	if err != nil {
		t.Fatalf("GetDomain: %v", err)
	}
	if got.AccessCount != 2 {
		t.Errorf("AccessCount = %d, want 2", got.AccessCount)
	}
	if got.LastAccessed.IsZero() {
		t.Error("LastAccessed should not be zero after touch")
	}
}

func testDomainNotFound(t *testing.T, store db.Store) {
	ctx := context.Background()
	_, err := store.GetDomain(ctx, "nonexistent.com")
	if err == nil {
		t.Fatal("expected error for nonexistent domain, got nil")
	}
	if !errors.Is(err, db.ErrNotFound) {
		t.Errorf("expected db.ErrNotFound, got %v", err)
	}
}

func testDomainUpsert(t *testing.T, store db.Store) {
	ctx := context.Background()

	// Set as allow
	if err := store.SetDomain(ctx, &db.DomainEntry{Domain: "api.upsert.com", Status: "allow", GrantedBy: "skill:web"}); err != nil {
		t.Fatalf("SetDomain: %v", err)
	}

	// Upsert to deny
	if err := store.SetDomain(ctx, &db.DomainEntry{Domain: "api.upsert.com", Status: "deny", GrantedBy: "user"}); err != nil {
		t.Fatalf("SetDomain: %v", err)
	}

	got, err := store.GetDomain(ctx, "api.upsert.com")
	if err != nil {
		t.Fatalf("GetDomain: %v", err)
	}
	if got.Status != "deny" {
		t.Errorf("Status = %q, want %q after upsert", got.Status, "deny")
	}
	if got.GrantedBy != "user" {
		t.Errorf("GrantedBy = %q, want %q after upsert", got.GrantedBy, "user")
	}
}

// --- Search & Summary Tests ---

func testSearchMessages(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	for _, m := range []db.Message{
		{AgentID: "agent1", Role: "user", Content: "tell me about golang", Source: "cli", Trust: "trusted"},
		{AgentID: "agent1", Role: "assistant", Content: "Go is a great language", Source: "llm", Trust: "trusted"},
		{AgentID: "agent1", Role: "user", Content: "what about python?", Source: "cli", Trust: "trusted"},
		{AgentID: "agent1", Role: "assistant", Content: "Python is also popular", Source: "llm", Trust: "trusted"},
	} {
		if err := store.AppendMessage(ctx, &m); err != nil {
			t.Fatalf("AppendMessage: %v", err)
		}
	}

	// Search for "golang" — should match 1 message
	got, err := store.SearchMessages(ctx, "agent1", "golang", 10)
	if err != nil {
		t.Fatalf("SearchMessages: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].Content != "tell me about golang" {
		t.Errorf("content = %q", got[0].Content)
	}

	// Search for "python" — matches both "what about python?" and "Python is also popular"
	got, err = store.SearchMessages(ctx, "agent1", "python", 10)
	if err != nil {
		t.Fatalf("SearchMessages python: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("python len = %d, want 2", len(got))
	}

	// Search with limit
	got, err = store.SearchMessages(ctx, "agent1", "a", 2)
	if err != nil {
		t.Fatalf("SearchMessages limit: %v", err)
	}
	if len(got) > 2 {
		t.Errorf("limit not respected: got %d", len(got))
	}

	// Search returns nothing for unmatched query
	got, err = store.SearchMessages(ctx, "agent1", "nonexistent_xyz", 10)
	if err != nil {
		t.Fatalf("SearchMessages no match: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected 0 results, got %d", len(got))
	}
}

func testInsertSummary(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Add some messages first
	if err := store.AppendMessage(ctx, &db.Message{AgentID: "agent1", Role: "user", Content: "hello", Source: "cli", Trust: "trusted"}); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}
	if err := store.AppendMessage(ctx, &db.Message{AgentID: "agent1", Role: "assistant", Content: "hi", Source: "llm", Trust: "trusted"}); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}

	// Insert summary
	summary := "Summary: User said hello, assistant responded."
	if err := store.InsertSummary(ctx, "agent1", summary); err != nil {
		t.Fatalf("InsertSummary: %v", err)
	}

	// Summary should appear in GetMessages
	msgs, err := store.GetMessages(ctx, "agent1", 10)
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	if len(msgs) != 3 {
		t.Fatalf("len = %d, want 3", len(msgs))
	}
	// Summary should be the last message (most recent)
	if msgs[2].Role != "system" {
		t.Errorf("summary role = %q, want system", msgs[2].Role)
	}
	if msgs[2].Source != "summary" {
		t.Errorf("summary source = %q, want summary", msgs[2].Source)
	}
	if msgs[2].Content != summary {
		t.Errorf("summary content = %q", msgs[2].Content)
	}

	// Summary should be searchable
	found, err := store.SearchMessages(ctx, "agent1", "Summary:", 10)
	if err != nil {
		t.Fatalf("SearchMessages summary: %v", err)
	}
	if len(found) != 1 {
		t.Fatalf("search summary len = %d, want 1", len(found))
	}
}

// --- FTS & Embedding Tests ---

func testSearchMessagesFTS(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	for _, m := range []db.Message{
		{AgentID: "agent1", Role: "user", Content: "tell me about golang", Source: "cli", Trust: "trusted"},
		{AgentID: "agent1", Role: "assistant", Content: "Go is a great language", Source: "llm", Trust: "trusted"},
		{AgentID: "agent1", Role: "user", Content: "what about python?", Source: "cli", Trust: "semi-trusted"},
	} {
		if err := store.AppendMessage(ctx, &m); err != nil {
			t.Fatalf("AppendMessage: %v", err)
		}
	}

	results, err := store.SearchMessagesFTS(ctx, "agent1", "golang", 10)
	if err != nil {
		t.Fatalf("SearchMessagesFTS: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("len = %d, want 1", len(results))
	}
	if results[0].Content != "tell me about golang" {
		t.Errorf("content = %q", results[0].Content)
	}
	if results[0].Score == 0 {
		t.Error("expected non-zero BM25 score")
	}
}

func testStoreAndGetEmbeddings(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	msg := &db.Message{AgentID: "agent1", Role: "user", Content: "test embedding", Source: "cli", Trust: "trusted"}
	if err := store.AppendMessage(ctx, msg); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}
	if msg.ID == 0 {
		t.Fatal("msg.ID not set after AppendMessage")
	}

	vec := []float32{0.1, 0.2, 0.3}
	if err := store.StoreEmbedding(ctx, msg.ID, vec, "test-model", 3); err != nil {
		t.Fatalf("StoreEmbedding: %v", err)
	}

	embeddings, err := store.GetEmbeddings(ctx, "agent1")
	if err != nil {
		t.Fatalf("GetEmbeddings: %v", err)
	}
	if len(embeddings) != 1 {
		t.Fatalf("len = %d, want 1", len(embeddings))
	}
	if embeddings[0].MemoryID != msg.ID {
		t.Errorf("MemoryID = %d, want %d", embeddings[0].MemoryID, msg.ID)
	}
	if embeddings[0].Model != "test-model" {
		t.Errorf("Model = %q", embeddings[0].Model)
	}
	if len(embeddings[0].Embedding) != 3 {
		t.Errorf("embedding len = %d, want 3", len(embeddings[0].Embedding))
	}
	if embeddings[0].Embedding[0] != 0.1 {
		t.Errorf("embedding[0] = %f, want 0.1", embeddings[0].Embedding[0])
	}
	if embeddings[0].Trust != "trusted" {
		t.Errorf("Trust = %q, want trusted", embeddings[0].Trust)
	}
}

func testGetEmbeddingCount(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	msg1 := &db.Message{AgentID: "agent1", Role: "user", Content: "msg1", Source: "cli", Trust: "trusted"}
	msg2 := &db.Message{AgentID: "agent1", Role: "user", Content: "msg2", Source: "cli", Trust: "trusted"}
	if err := store.AppendMessage(ctx, msg1); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}
	if err := store.AppendMessage(ctx, msg2); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}

	count, err := store.GetEmbeddingCount(ctx, "agent1")
	if err != nil {
		t.Fatalf("GetEmbeddingCount: %v", err)
	}
	if count != 0 {
		t.Errorf("count = %d, want 0", count)
	}

	if err := store.StoreEmbedding(ctx, msg1.ID, []float32{0.1}, "m", 1); err != nil {
		t.Fatalf("StoreEmbedding: %v", err)
	}
	count, _ = store.GetEmbeddingCount(ctx, "agent1")
	if count != 1 {
		t.Errorf("count = %d, want 1", count)
	}
}

func testGetUnembeddedMessages(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	msg1 := &db.Message{AgentID: "agent1", Role: "user", Content: "embedded", Source: "cli", Trust: "trusted"}
	msg2 := &db.Message{AgentID: "agent1", Role: "user", Content: "not embedded", Source: "cli", Trust: "trusted"}
	if err := store.AppendMessage(ctx, msg1); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}
	if err := store.AppendMessage(ctx, msg2); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}

	if err := store.StoreEmbedding(ctx, msg1.ID, []float32{0.1}, "m", 1); err != nil {
		t.Fatalf("StoreEmbedding: %v", err)
	}

	msgs, err := store.GetUnembeddedMessages(ctx, "agent1", 10)
	if err != nil {
		t.Fatalf("GetUnembeddedMessages: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("len = %d, want 1", len(msgs))
	}
	if msgs[0].Content != "not embedded" {
		t.Errorf("content = %q, want 'not embedded'", msgs[0].Content)
	}
}

func testFTSTriggerSync(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Insert a message — FTS trigger should index it
	if err := store.AppendMessage(ctx, &db.Message{AgentID: "agent1", Role: "user", Content: "unique xylophone word", Source: "cli", Trust: "trusted"}); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}

	// Should be searchable via FTS
	results, err := store.SearchMessagesFTS(ctx, "agent1", "xylophone", 10)
	if err != nil {
		t.Fatalf("SearchMessagesFTS: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("len = %d, want 1 (trigger not syncing FTS?)", len(results))
	}
}

func testGetMessagesByID(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Insert 5 messages
	var ids []int64
	for i := range 5 {
		msg := &db.Message{
			AgentID: "agent1", Role: "user",
			Content: fmt.Sprintf("msg %d", i),
			Source:  "cli", Trust: "trusted",
		}
		if err := store.AppendMessage(ctx, msg); err != nil {
			t.Fatalf("AppendMessage: %v", err)
		}
		ids = append(ids, msg.ID)
	}

	// Get 2 messages before the last one
	msgs, err := store.GetMessagesByID(ctx, "agent1", ids[4], 2)
	if err != nil {
		t.Fatalf("GetMessagesByID: %v", err)
	}
	if len(msgs) != 2 {
		t.Fatalf("len = %d, want 2", len(msgs))
	}
	// Should be in chronological order: msg 2, msg 3
	if msgs[0].Content != "msg 2" {
		t.Errorf("first = %q, want 'msg 2'", msgs[0].Content)
	}
	if msgs[1].Content != "msg 3" {
		t.Errorf("second = %q, want 'msg 3'", msgs[1].Content)
	}

	// Get with beforeID=0 — returns most recent
	msgs, err = store.GetMessagesByID(ctx, "agent1", 0, 3)
	if err != nil {
		t.Fatalf("GetMessagesByID(0): %v", err)
	}
	if len(msgs) != 3 {
		t.Fatalf("len = %d, want 3", len(msgs))
	}
	if msgs[2].Content != "msg 4" {
		t.Errorf("last = %q, want 'msg 4'", msgs[2].Content)
	}
}

func testGetMessagesByIDs(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Insert 5 messages
	var ids []int64
	for i := range 5 {
		msg := &db.Message{
			AgentID: "agent1", Role: "user",
			Content: fmt.Sprintf("msg %d", i),
			Source:  "cli", Trust: "trusted",
		}
		if err := store.AppendMessage(ctx, msg); err != nil {
			t.Fatalf("AppendMessage: %v", err)
		}
		ids = append(ids, msg.ID)
	}

	// Fetch specific IDs (0, 2, 4)
	want := []int64{ids[0], ids[2], ids[4]}
	msgs, err := store.GetMessagesByIDs(ctx, "agent1", want)
	if err != nil {
		t.Fatalf("GetMessagesByIDs: %v", err)
	}
	if len(msgs) != 3 {
		t.Fatalf("len = %d, want 3", len(msgs))
	}
	if msgs[0].Content != "msg 0" {
		t.Errorf("first = %q, want 'msg 0'", msgs[0].Content)
	}
	if msgs[1].Content != "msg 2" {
		t.Errorf("second = %q, want 'msg 2'", msgs[1].Content)
	}
	if msgs[2].Content != "msg 4" {
		t.Errorf("third = %q, want 'msg 4'", msgs[2].Content)
	}

	// Empty IDs returns nil
	msgs, err = store.GetMessagesByIDs(ctx, "agent1", nil)
	if err != nil {
		t.Fatalf("GetMessagesByIDs(nil): %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("empty IDs should return empty, got %d", len(msgs))
	}

	// IDs from different agent should return empty
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent2", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	msgs, err = store.GetMessagesByIDs(ctx, "agent2", want)
	if err != nil {
		t.Fatalf("GetMessagesByIDs(agent2): %v", err)
	}
	if len(msgs) != 0 {
		t.Errorf("different agent should return empty, got %d", len(msgs))
	}
}

func testAppendMessageSetsID(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "agent1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	msg := &db.Message{AgentID: "agent1", Role: "user", Content: "test", Source: "cli", Trust: "trusted"}
	if err := store.AppendMessage(ctx, msg); err != nil {
		t.Fatalf("AppendMessage: %v", err)
	}
	if msg.ID == 0 {
		t.Error("msg.ID should be set after AppendMessage")
	}
}

// --- Binding Tests ---

func testCreateAndListBindings(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "bot1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	if err := store.CreateAgent(ctx, &db.Agent{ID: "bot2", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	b1 := &db.Binding{Channel: "telegram", Contact: "12345", AgentID: "bot1"}
	b2 := &db.Binding{Channel: "telegram", AgentID: "bot2"}
	b3 := &db.Binding{Channel: "discord", Contact: "ch99", AgentID: "bot1"}

	for _, b := range []*db.Binding{b1, b2, b3} {
		if err := store.CreateBinding(ctx, b); err != nil {
			t.Fatalf("CreateBinding: %v", err)
		}
		if b.ID == 0 {
			t.Error("expected non-zero ID after CreateBinding")
		}
	}

	// List all
	all, err := store.ListBindings(ctx, "")
	if err != nil {
		t.Fatalf("ListBindings: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("len = %d, want 3", len(all))
	}

	// List by channel
	tg, err := store.ListBindings(ctx, "telegram")
	if err != nil {
		t.Fatalf("ListBindings telegram: %v", err)
	}
	if len(tg) != 2 {
		t.Fatalf("telegram len = %d, want 2", len(tg))
	}
	// Highest priority first
	if tg[0].Priority < tg[1].Priority {
		t.Errorf("expected descending priority, got %d then %d", tg[0].Priority, tg[1].Priority)
	}
}

func testDeleteBinding(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "bot1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	b := &db.Binding{Channel: "telegram", Contact: "999", AgentID: "bot1"}
	if err := store.CreateBinding(ctx, b); err != nil {
		t.Fatalf("CreateBinding: %v", err)
	}

	if err := store.DeleteBinding(ctx, b.ID); err != nil {
		t.Fatalf("DeleteBinding: %v", err)
	}

	list, err := store.ListBindings(ctx, "telegram")
	if err != nil {
		t.Fatalf("ListBindings: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected 0 bindings after delete, got %d", len(list))
	}
}

func testResolveBindingExactContact(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "bot1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	if err := store.CreateAgent(ctx, &db.Agent{ID: "bot2", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Channel-only fallback
	if err := store.CreateBinding(ctx, &db.Binding{Channel: "telegram", AgentID: "bot2"}); err != nil {
		t.Fatalf("CreateBinding: %v", err)
	}
	// Exact contact match
	if err := store.CreateBinding(ctx, &db.Binding{Channel: "telegram", Contact: "42", AgentID: "bot1"}); err != nil {
		t.Fatalf("CreateBinding: %v", err)
	}

	got, err := store.ResolveBinding(ctx, "telegram", "42")
	if err != nil {
		t.Fatalf("ResolveBinding: %v", err)
	}
	if got.AgentID != "bot1" {
		t.Errorf("AgentID = %q, want bot1", got.AgentID)
	}
	if got.Priority != 20 {
		t.Errorf("Priority = %d, want 20", got.Priority)
	}
}

func testResolveBindingChannelFallback(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "bot1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Channel-only binding (no contact)
	if err := store.CreateBinding(ctx, &db.Binding{Channel: "telegram", AgentID: "bot1"}); err != nil {
		t.Fatalf("CreateBinding: %v", err)
	}

	got, err := store.ResolveBinding(ctx, "telegram", "unknown-chat")
	if err != nil {
		t.Fatalf("ResolveBinding: %v", err)
	}
	if got.AgentID != "bot1" {
		t.Errorf("AgentID = %q, want bot1", got.AgentID)
	}
	if got.Priority != 5 {
		t.Errorf("Priority = %d, want 5", got.Priority)
	}
}

func testResolveBindingWildcard(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "bot1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Wildcard binding
	if err := store.CreateBinding(ctx, &db.Binding{Channel: "*", AgentID: "bot1"}); err != nil {
		t.Fatalf("CreateBinding: %v", err)
	}

	got, err := store.ResolveBinding(ctx, "discord", "any-channel")
	if err != nil {
		t.Fatalf("ResolveBinding: %v", err)
	}
	if got.AgentID != "bot1" {
		t.Errorf("AgentID = %q, want bot1", got.AgentID)
	}
	if got.Priority != 0 {
		t.Errorf("Priority = %d, want 0", got.Priority)
	}
}

func testResolveBindingNotFound(t *testing.T, store db.Store) {
	ctx := context.Background()
	_, err := store.ResolveBinding(ctx, "telegram", "12345")
	if err == nil {
		t.Fatal("expected error for no binding, got nil")
	}
	if !errors.Is(err, db.ErrNotFound) {
		t.Errorf("expected db.ErrNotFound, got %v", err)
	}
}

func testResolveBindingPriority(t *testing.T, store db.Store) {
	ctx := context.Background()
	if err := store.CreateAgent(ctx, &db.Agent{ID: "bot1", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	if err := store.CreateAgent(ctx, &db.Agent{ID: "bot2", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	if err := store.CreateAgent(ctx, &db.Agent{ID: "bot3", Model: "m", WorkspacePath: "w"}); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}

	// Wildcard (priority 0)
	if err := store.CreateBinding(ctx, &db.Binding{Channel: "*", AgentID: "bot3"}); err != nil {
		t.Fatalf("CreateBinding: %v", err)
	}
	// Channel-only (priority 5)
	if err := store.CreateBinding(ctx, &db.Binding{Channel: "telegram", AgentID: "bot2"}); err != nil {
		t.Fatalf("CreateBinding: %v", err)
	}
	// Contact-specific (priority 20)
	if err := store.CreateBinding(ctx, &db.Binding{Channel: "telegram", Contact: "vip", AgentID: "bot1"}); err != nil {
		t.Fatalf("CreateBinding: %v", err)
	}

	// VIP contact should get bot1
	got, err := store.ResolveBinding(ctx, "telegram", "vip")
	if err != nil {
		t.Fatalf("ResolveBinding vip: %v", err)
	}
	if got.AgentID != "bot1" {
		t.Errorf("vip AgentID = %q, want bot1", got.AgentID)
	}

	// Regular contact should get bot2 (channel fallback)
	got, err = store.ResolveBinding(ctx, "telegram", "regular")
	if err != nil {
		t.Fatalf("ResolveBinding regular: %v", err)
	}
	if got.AgentID != "bot2" {
		t.Errorf("regular AgentID = %q, want bot2", got.AgentID)
	}

	// Unknown channel should get bot3 (wildcard)
	got, err = store.ResolveBinding(ctx, "slack", "any")
	if err != nil {
		t.Fatalf("ResolveBinding slack: %v", err)
	}
	if got.AgentID != "bot3" {
		t.Errorf("slack AgentID = %q, want bot3", got.AgentID)
	}
}

// --- Webhook Log Tests ---

func testLogAndListWebhooks(t *testing.T, store db.Store) {
	ctx := context.Background()

	entry := &db.WebhookEntry{
		Webhook:        "github",
		Headers:        `{"Content-Type":"application/json"}`,
		Body:           `{"action":"push"}`,
		SourceIP:       "1.2.3.4",
		SignatureValid: true,
		AgentID:        "coder",
	}
	if err := store.LogWebhook(ctx, entry); err != nil {
		t.Fatalf("LogWebhook: %v", err)
	}
	if entry.ID == 0 {
		t.Error("expected non-zero ID after LogWebhook")
	}

	// Log a second entry
	entry2 := &db.WebhookEntry{
		Webhook: "stripe",
		Body:    `{"type":"charge.succeeded"}`,
		AgentID: "billing",
	}
	if err := store.LogWebhook(ctx, entry2); err != nil {
		t.Fatalf("LogWebhook: %v", err)
	}

	// List all
	all, err := store.ListWebhookLog(ctx, "", 10)
	if err != nil {
		t.Fatalf("ListWebhookLog: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("len = %d, want 2", len(all))
	}
	// Most recent first
	if all[0].Webhook != "stripe" {
		t.Errorf("first = %q, want stripe", all[0].Webhook)
	}
	if all[1].Webhook != "github" {
		t.Errorf("second = %q, want github", all[1].Webhook)
	}
	if !all[1].SignatureValid {
		t.Error("expected SignatureValid=true for github entry")
	}
	if all[1].SourceIP != "1.2.3.4" {
		t.Errorf("SourceIP = %q, want 1.2.3.4", all[1].SourceIP)
	}
}

func testListWebhooksFilterByName(t *testing.T, store db.Store) {
	ctx := context.Background()

	for _, name := range []string{"github", "github", "stripe"} {
		if err := store.LogWebhook(ctx, &db.WebhookEntry{
			Webhook: name,
			Body:    `{}`,
		}); err != nil {
			t.Fatalf("LogWebhook: %v", err)
		}
	}

	gh, err := store.ListWebhookLog(ctx, "github", 10)
	if err != nil {
		t.Fatalf("ListWebhookLog github: %v", err)
	}
	if len(gh) != 2 {
		t.Fatalf("github len = %d, want 2", len(gh))
	}

	stripe, err := store.ListWebhookLog(ctx, "stripe", 10)
	if err != nil {
		t.Fatalf("ListWebhookLog stripe: %v", err)
	}
	if len(stripe) != 1 {
		t.Fatalf("stripe len = %d, want 1", len(stripe))
	}
}

// --- Migration Tests ---

func testMigrateIdempotent(t *testing.T, store db.Store) {
	ctx := context.Background()
	// Running Migrate again should be a no-op
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}
	// And a third time
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("third Migrate: %v", err)
	}
}
