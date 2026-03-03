package webhook

import (
	"bytes"
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
	"smithly.dev/internal/db"
)

// mockStore implements just the webhook methods of db.Store for testing.
type mockStore struct {
	mu      sync.Mutex
	entries []*db.WebhookEntry
}

func (m *mockStore) LogWebhook(_ context.Context, entry *db.WebhookEntry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry.ID = int64(len(m.entries) + 1)
	m.entries = append(m.entries, entry)
	return nil
}

func (m *mockStore) getEntries() []*db.WebhookEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*db.WebhookEntry, len(m.entries))
	copy(out, m.entries)
	return out
}

// Satisfy the db.Store interface — only LogWebhook is used by the server handler.
func (m *mockStore) Close() error                                                    { return nil }
func (m *mockStore) Migrate(_ context.Context) error                                 { return nil }
func (m *mockStore) CreateAgent(_ context.Context, _ *db.Agent) error                { return nil }
func (m *mockStore) GetAgent(_ context.Context, _ string) (*db.Agent, error)         { return nil, nil }
func (m *mockStore) ListAgents(_ context.Context) ([]*db.Agent, error)               { return nil, nil }
func (m *mockStore) DeleteAgent(_ context.Context, _ string) error                   { return nil }
func (m *mockStore) AppendMessage(_ context.Context, msg *db.Message) error          { msg.ID = 1; return nil }
func (m *mockStore) GetMessages(_ context.Context, _ string, _ int) ([]*db.Message, error) {
	return nil, nil
}
func (m *mockStore) GetMessagesByID(_ context.Context, _ string, _ int64, _ int) ([]*db.Message, error) {
	return nil, nil
}
func (m *mockStore) GetMessagesByIDs(_ context.Context, _ string, _ []int64) ([]*db.Message, error) {
	return nil, nil
}
func (m *mockStore) SearchMessages(_ context.Context, _, _ string, _ int) ([]*db.Message, error) {
	return nil, nil
}
func (m *mockStore) SearchMessagesFTS(_ context.Context, _, _ string, _ int) ([]*db.SearchResult, error) {
	return nil, nil
}
func (m *mockStore) InsertSummary(_ context.Context, _, _ string) error { return nil }
func (m *mockStore) StoreEmbedding(_ context.Context, _ int64, _ []float32, _ string, _ int) error {
	return nil
}
func (m *mockStore) GetEmbeddings(_ context.Context, _ string) ([]db.MemoryEmbedding, error) {
	return nil, nil
}
func (m *mockStore) GetEmbeddingCount(_ context.Context, _ string) (int, error) { return 0, nil }
func (m *mockStore) GetUnembeddedMessages(_ context.Context, _ string, _ int) ([]*db.Message, error) {
	return nil, nil
}
func (m *mockStore) LogAudit(_ context.Context, _ *db.AuditEntry) error { return nil }
func (m *mockStore) GetAuditLog(_ context.Context, _ db.AuditQuery) ([]*db.AuditEntry, error) {
	return nil, nil
}
func (m *mockStore) GetDomain(_ context.Context, _ string) (*db.DomainEntry, error) {
	return nil, nil
}
func (m *mockStore) ListDomains(_ context.Context) ([]*db.DomainEntry, error)          { return nil, nil }
func (m *mockStore) SetDomain(_ context.Context, _ *db.DomainEntry) error              { return nil }
func (m *mockStore) TouchDomain(_ context.Context, _ string) error                     { return nil }
func (m *mockStore) CreateBinding(_ context.Context, _ *db.Binding) error              { return nil }
func (m *mockStore) ListBindings(_ context.Context, _ string) ([]*db.Binding, error)   { return nil, nil }
func (m *mockStore) DeleteBinding(_ context.Context, _ int64) error                    { return nil }
func (m *mockStore) ResolveBinding(_ context.Context, _, _ string) (*db.Binding, error) {
	return nil, nil
}
func (m *mockStore) ListWebhookLog(_ context.Context, _ string, _ int) ([]*db.WebhookEntry, error) {
	return nil, nil
}

// trackingAgentGetter returns agents by ID for testing.
type trackingAgentGetter struct {
	agents map[string]*agent.Agent
}

func (t *trackingAgentGetter) GetAgent(id string) (*agent.Agent, bool) {
	if t.agents != nil {
		a, ok := t.agents[id]
		return a, ok
	}
	return nil, false
}

func newTestServer(webhooks map[string]*WebhookConfig, agents channels.AgentGetter) (*Server, *mockStore) {
	store := &mockStore{}
	if agents == nil {
		agents = &trackingAgentGetter{}
	}
	s := &Server{
		Bind:     "127.0.0.1",
		Port:     0,
		Webhooks: webhooks,
		Store:    store,
		Agents:   agents,
	}
	return s, store
}

func TestWebhookDelivery(t *testing.T) {
	s, store := newTestServer(map[string]*WebhookConfig{
		"github": {Name: "github", AgentID: "coder"},
	}, nil)

	body := `{"action":"push"}`
	req := httptest.NewRequest("POST", "/w/github", strings.NewReader(body))
	w := httptest.NewRecorder()

	s.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	var resp map[string]string
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["status"] != "accepted" {
		t.Errorf("status = %q, want accepted", resp["status"])
	}

	entries := store.getEntries()
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(entries))
	}
	if entries[0].Webhook != "github" {
		t.Errorf("webhook = %q, want github", entries[0].Webhook)
	}
	if entries[0].Body != body {
		t.Errorf("body = %q", entries[0].Body)
	}
}

func TestWebhookHMACValid(t *testing.T) {
	secret := "test-secret"
	s, store := newTestServer(map[string]*WebhookConfig{
		"github": {Name: "github", Secret: secret, AgentID: "coder"},
	}, nil)

	body := []byte(`{"action":"push"}`)
	sig := computeHMAC(body, secret)

	req := httptest.NewRequest("POST", "/w/github", bytes.NewReader(body))
	req.Header.Set("X-Hub-Signature-256", sig)
	w := httptest.NewRecorder()

	s.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	entries := store.getEntries()
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(entries))
	}
	if !entries[0].SignatureValid {
		t.Error("expected SignatureValid=true")
	}
}

func TestWebhookHMACInvalid(t *testing.T) {
	s, store := newTestServer(map[string]*WebhookConfig{
		"github": {Name: "github", Secret: "real-secret", AgentID: "coder"},
	}, nil)

	body := []byte(`{"action":"push"}`)
	req := httptest.NewRequest("POST", "/w/github", bytes.NewReader(body))
	req.Header.Set("X-Hub-Signature-256", "sha256=0000000000000000000000000000000000000000000000000000000000000000")
	w := httptest.NewRecorder()

	s.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}

	// Entry should still be logged
	entries := store.getEntries()
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1 (should log even on failed sig)", len(entries))
	}
	if entries[0].SignatureValid {
		t.Error("expected SignatureValid=false")
	}
}

func TestWebhookHMACMissing(t *testing.T) {
	s, _ := newTestServer(map[string]*WebhookConfig{
		"github": {Name: "github", Secret: "my-secret", AgentID: "coder"},
	}, nil)

	body := []byte(`{"action":"push"}`)
	req := httptest.NewRequest("POST", "/w/github", bytes.NewReader(body))
	w := httptest.NewRecorder()

	s.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (missing signature)", w.Code)
	}
}

func TestWebhookUnknownName(t *testing.T) {
	s, _ := newTestServer(map[string]*WebhookConfig{
		"github": {Name: "github", AgentID: "coder"},
	}, nil)

	req := httptest.NewRequest("POST", "/w/nonexistent", strings.NewReader("{}"))
	w := httptest.NewRecorder()

	s.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestWebhookOversizedBody(t *testing.T) {
	s, _ := newTestServer(map[string]*WebhookConfig{
		"test": {Name: "test", AgentID: "coder"},
	}, nil)

	big := make([]byte, maxBodySize+1)
	for i := range big {
		big[i] = 'x'
	}

	req := httptest.NewRequest("POST", "/w/test", bytes.NewReader(big))
	w := httptest.NewRecorder()

	s.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", w.Code)
	}
}

func TestWebhookFastResponse(t *testing.T) {
	s, _ := newTestServer(map[string]*WebhookConfig{
		"test": {Name: "test", AgentID: "coder"},
	}, nil)

	body := `{"hello":"world"}`
	req := httptest.NewRequest("POST", "/w/test", strings.NewReader(body))
	w := httptest.NewRecorder()

	start := time.Now()
	s.Handler().ServeHTTP(w, req)
	elapsed := time.Since(start)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	if elapsed > 2*time.Second {
		t.Errorf("response took %v, expected fast response", elapsed)
	}
}
