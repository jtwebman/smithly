// Package credentials manages secret storage (OAuth2 tokens, API keys, etc.)
// The Store interface allows swapping backends: local file, env vars, Vault, etc.
package credentials

import (
	"context"
	"time"
)

// Store manages secrets (OAuth2 tokens, API keys, etc.)
type Store interface {
	// Get returns a credential by provider name. Returns nil, nil if not found.
	Get(ctx context.Context, provider string) (*OAuth2Token, error)
	// Put saves or updates a credential.
	Put(ctx context.Context, provider string, token *OAuth2Token) error
	// Delete removes a credential.
	Delete(ctx context.Context, provider string) error
	// List returns all stored provider names.
	List(ctx context.Context) ([]string, error)
}

// OAuth2Token holds the tokens for an OAuth2 provider.
type OAuth2Token struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	TokenType    string    `json:"token_type"`
	Expiry       time.Time `json:"expiry"`
}

// Valid reports whether the access token is present and not expired.
// A token with no expiry is always valid.
func (t *OAuth2Token) Valid() bool {
	if t.AccessToken == "" {
		return false
	}
	if t.Expiry.IsZero() {
		return true
	}
	// Consider expired 30 seconds early to avoid race conditions.
	return time.Now().Before(t.Expiry.Add(-30 * time.Second))
}
