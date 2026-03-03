package channels

import (
	"context"
	"errors"
	"fmt"

	"smithly.dev/internal/agent"
	"smithly.dev/internal/db"
)

// BindingResolver resolves agents via DB bindings with a configurable default fallback.
type BindingResolver struct {
	Store        db.Store
	Agents       AgentGetter
	DefaultAgent string
}

// ResolveAgent looks up a binding for the given channel/contact pair,
// falls back to DefaultAgent if no binding matches or the bound agent isn't registered.
func (r *BindingResolver) ResolveAgent(ctx context.Context, channel, contact string) (*agent.Agent, error) {
	binding, err := r.Store.ResolveBinding(ctx, channel, contact)
	if err == nil {
		if a, ok := r.Agents.GetAgent(binding.AgentID); ok {
			return a, nil
		}
	} else if !errors.Is(err, db.ErrNotFound) {
		return nil, fmt.Errorf("resolve binding: %w", err)
	}

	// Fall back to default agent
	if r.DefaultAgent != "" {
		if a, ok := r.Agents.GetAgent(r.DefaultAgent); ok {
			return a, nil
		}
	}

	return nil, fmt.Errorf("no agent found for channel %q contact %q", channel, contact)
}
