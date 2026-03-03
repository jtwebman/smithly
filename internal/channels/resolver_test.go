package channels

import (
	"context"
	"testing"

	"smithly.dev/internal/agent"
	"smithly.dev/internal/db"
)

// stubStore implements db.Store.ResolveBinding for testing.
type stubStore struct {
	db.Store // embed to satisfy interface; only ResolveBinding is called
	binding  *db.Binding
	err      error
}

func (s *stubStore) ResolveBinding(_ context.Context, _, _ string) (*db.Binding, error) {
	return s.binding, s.err
}

// stubAgents implements AgentGetter for testing.
type stubAgents struct {
	agents map[string]*agent.Agent
}

func (s *stubAgents) GetAgent(id string) (*agent.Agent, bool) {
	a, ok := s.agents[id]
	return a, ok
}

func TestBindingResolverMatch(t *testing.T) {
	a := &agent.Agent{ID: "bot1"}
	r := &BindingResolver{
		Store: &stubStore{
			binding: &db.Binding{AgentID: "bot1"},
		},
		Agents:       &stubAgents{agents: map[string]*agent.Agent{"bot1": a}},
		DefaultAgent: "fallback",
	}

	got, err := r.ResolveAgent(context.Background(), "telegram", "123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ID != "bot1" {
		t.Errorf("got agent %q, want bot1", got.ID)
	}
}

func TestBindingResolverFallbackToDefault(t *testing.T) {
	fallback := &agent.Agent{ID: "default"}
	r := &BindingResolver{
		Store:        &stubStore{err: db.ErrNotFound},
		Agents:       &stubAgents{agents: map[string]*agent.Agent{"default": fallback}},
		DefaultAgent: "default",
	}

	got, err := r.ResolveAgent(context.Background(), "telegram", "unknown")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ID != "default" {
		t.Errorf("got agent %q, want default", got.ID)
	}
}

func TestBindingResolverUnknownAgent(t *testing.T) {
	// Binding exists but references an agent not in registry → fall back to default
	fallback := &agent.Agent{ID: "default"}
	r := &BindingResolver{
		Store: &stubStore{
			binding: &db.Binding{AgentID: "ghost"},
		},
		Agents:       &stubAgents{agents: map[string]*agent.Agent{"default": fallback}},
		DefaultAgent: "default",
	}

	got, err := r.ResolveAgent(context.Background(), "telegram", "123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ID != "default" {
		t.Errorf("got agent %q, want default", got.ID)
	}
}

func TestBindingResolverNoDefault(t *testing.T) {
	r := &BindingResolver{
		Store:  &stubStore{err: db.ErrNotFound},
		Agents: &stubAgents{agents: map[string]*agent.Agent{}},
	}

	_, err := r.ResolveAgent(context.Background(), "telegram", "123")
	if err == nil {
		t.Fatal("expected error when no binding and no default, got nil")
	}
}
