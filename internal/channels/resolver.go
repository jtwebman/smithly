package channels

import (
	"context"

	"smithly.dev/internal/agent"
)

// AgentResolver resolves which agent should handle a message based on channel and contact.
type AgentResolver interface {
	ResolveAgent(ctx context.Context, channel, contact string) (*agent.Agent, error)
}

// AgentGetter retrieves a registered agent by ID.
type AgentGetter interface {
	GetAgent(id string) (*agent.Agent, bool)
}
