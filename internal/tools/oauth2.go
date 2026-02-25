package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"smithly.dev/internal/config"
	"smithly.dev/internal/credentials"
)

// OAuth2Tool returns bearer tokens for configured OAuth2 providers.
// Handles token refresh transparently.
type OAuth2Tool struct {
	providers map[string]*oauth2Provider
}

type oauth2Provider struct {
	config config.OAuth2Config
	store  credentials.Store
	client *http.Client
}

// NewOAuth2Tool creates an OAuth2Tool from config and a credentials store.
func NewOAuth2Tool(configs []config.OAuth2Config, store credentials.Store) *OAuth2Tool {
	providers := make(map[string]*oauth2Provider, len(configs))
	for _, cfg := range configs {
		providers[cfg.Name] = &oauth2Provider{
			config: cfg,
			store:  store,
			client: &http.Client{Timeout: 10 * time.Second},
		}
	}
	return &OAuth2Tool{providers: providers}
}

// NewOAuth2ToolWithClient creates an OAuth2Tool with a custom HTTP client (for testing).
func NewOAuth2ToolWithClient(configs []config.OAuth2Config, store credentials.Store, client *http.Client) *OAuth2Tool {
	providers := make(map[string]*oauth2Provider, len(configs))
	for _, cfg := range configs {
		providers[cfg.Name] = &oauth2Provider{
			config: cfg,
			store:  store,
			client: client,
		}
	}
	return &OAuth2Tool{providers: providers}
}

func (o *OAuth2Tool) Name() string { return "oauth2" }
func (o *OAuth2Tool) Description() string {
	return "Get a bearer token for an OAuth2 provider. Returns 'Bearer <token>' for use in API calls."
}
func (o *OAuth2Tool) NeedsApproval() bool { return false }

func (o *OAuth2Tool) Parameters() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"provider": {
				"type": "string",
				"description": "OAuth2 provider name (e.g., 'google', 'microsoft')"
			}
		},
		"required": ["provider"]
	}`)
}

func (o *OAuth2Tool) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Provider string `json:"provider"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("parse args: %w", err)
	}
	if params.Provider == "" {
		return "", fmt.Errorf("provider is required")
	}

	token, err := o.GetToken(ctx, params.Provider)
	if err != nil {
		return "", err
	}
	return "Bearer " + token, nil
}

// GetToken returns a valid access token for the named provider.
// Refreshes the token if expired.
func (o *OAuth2Tool) GetToken(ctx context.Context, provider string) (string, error) {
	p, ok := o.providers[provider]
	if !ok {
		names := make([]string, 0, len(o.providers))
		for k := range o.providers {
			names = append(names, k)
		}
		return "", fmt.Errorf("unknown OAuth2 provider %q (configured: %s)", provider, strings.Join(names, ", "))
	}

	tok, err := p.store.Get(ctx, provider)
	if err != nil {
		return "", fmt.Errorf("read credentials: %w", err)
	}
	if tok == nil {
		return "", fmt.Errorf("OAuth2 provider %q not authorized. Run: smithly oauth2 auth %s", provider, provider)
	}

	if tok.Valid() {
		return tok.AccessToken, nil
	}

	// Token expired — try refresh
	if tok.RefreshToken == "" {
		return "", fmt.Errorf("OAuth2 token for %q expired and no refresh token available. Run: smithly oauth2 auth %s", provider, provider)
	}

	refreshed, err := p.refresh(ctx, tok.RefreshToken)
	if err != nil {
		return "", fmt.Errorf("refresh token for %q: %w", provider, err)
	}

	// Preserve refresh token if server didn't send a new one
	if refreshed.RefreshToken == "" {
		refreshed.RefreshToken = tok.RefreshToken
	}

	if err := p.store.Put(ctx, provider, refreshed); err != nil {
		return "", fmt.Errorf("save refreshed token: %w", err)
	}

	return refreshed.AccessToken, nil
}

// HasProvider checks if a provider is configured.
func (o *OAuth2Tool) HasProvider(name string) bool {
	_, ok := o.providers[name]
	return ok
}

// refresh exchanges a refresh token for a new access token.
func (p *oauth2Provider) refresh(ctx context.Context, refreshToken string) (*credentials.OAuth2Token, error) {
	data := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {p.config.ClientID},
		"client_secret": {p.config.ClientSecret},
	}

	req, err := http.NewRequestWithContext(ctx, "POST", p.config.TokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token endpoint returned HTTP %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("parse token response: %w", err)
	}

	tok := &credentials.OAuth2Token{
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		TokenType:    tokenResp.TokenType,
	}
	if tokenResp.ExpiresIn > 0 {
		tok.Expiry = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
	}
	return tok, nil
}
