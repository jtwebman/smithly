package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"smithly.dev/internal/config"
	"smithly.dev/internal/credentials"
)

// memStore is an in-memory credentials store for testing.
type memStore struct {
	tokens map[string]*credentials.OAuth2Token
}

func newMemStore() *memStore {
	return &memStore{tokens: make(map[string]*credentials.OAuth2Token)}
}

func (m *memStore) Get(_ context.Context, provider string) (*credentials.OAuth2Token, error) {
	tok := m.tokens[provider]
	return tok, nil
}

func (m *memStore) Put(_ context.Context, provider string, token *credentials.OAuth2Token) error {
	m.tokens[provider] = token
	return nil
}

func (m *memStore) Delete(_ context.Context, provider string) error {
	delete(m.tokens, provider)
	return nil
}

func (m *memStore) List(_ context.Context) ([]string, error) {
	var names []string
	for k := range m.tokens {
		return append(names, k), nil
	}
	return names, nil
}

func TestOAuth2ToolBasic(t *testing.T) {
	store := newMemStore()
	store.tokens["google"] = &credentials.OAuth2Token{
		AccessToken: "valid-token",
		Expiry:      time.Now().Add(time.Hour),
	}

	tool := NewOAuth2Tool([]config.OAuth2Config{
		{Name: "google", ClientID: "id", ClientSecret: "secret", TokenURL: "http://example.com/token"},
	}, store)

	if tool.Name() != "oauth2" {
		t.Errorf("name = %q, want %q", tool.Name(), "oauth2")
	}
	if tool.NeedsApproval() {
		t.Error("NeedsApproval should be false")
	}

	result, err := tool.Run(context.Background(), json.RawMessage(`{"provider": "google"}`))
	if err != nil {
		t.Fatal(err)
	}
	if result != "Bearer valid-token" {
		t.Errorf("result = %q, want %q", result, "Bearer valid-token")
	}
}

func TestOAuth2ToolUnknownProvider(t *testing.T) {
	tool := NewOAuth2Tool([]config.OAuth2Config{
		{Name: "google"},
	}, newMemStore())

	_, err := tool.Run(context.Background(), json.RawMessage(`{"provider": "github"}`))
	if err == nil {
		t.Error("expected error for unknown provider")
	}
}

func TestOAuth2ToolNotAuthorized(t *testing.T) {
	tool := NewOAuth2Tool([]config.OAuth2Config{
		{Name: "google"},
	}, newMemStore())

	_, err := tool.Run(context.Background(), json.RawMessage(`{"provider": "google"}`))
	if err == nil {
		t.Error("expected error for unauthorized provider")
	}
}

func TestOAuth2ToolRefresh(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("grant_type") != "refresh_token" {
			t.Errorf("grant_type = %q", r.Form.Get("grant_type"))
		}
		if r.Form.Get("refresh_token") != "my-refresh" {
			t.Errorf("refresh_token = %q", r.Form.Get("refresh_token"))
		}
		if r.Form.Get("client_id") != "test-id" {
			t.Errorf("client_id = %q", r.Form.Get("client_id"))
		}

		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{
			"access_token": "new-access-token",
			"token_type": "Bearer",
			"expires_in": 3600
		}`)
	}))
	defer srv.Close()

	store := newMemStore()
	store.tokens["google"] = &credentials.OAuth2Token{
		AccessToken:  "expired-token",
		RefreshToken: "my-refresh",
		Expiry:       time.Now().Add(-time.Hour), // expired
	}

	tool := NewOAuth2ToolWithClient([]config.OAuth2Config{
		{Name: "google", ClientID: "test-id", ClientSecret: "test-secret", TokenURL: srv.URL},
	}, store, srv.Client())

	result, err := tool.Run(context.Background(), json.RawMessage(`{"provider": "google"}`))
	if err != nil {
		t.Fatal(err)
	}
	if result != "Bearer new-access-token" {
		t.Errorf("result = %q, want %q", result, "Bearer new-access-token")
	}

	// Verify token was persisted
	saved := store.tokens["google"]
	if saved.AccessToken != "new-access-token" {
		t.Errorf("saved access_token = %q", saved.AccessToken)
	}
	// Refresh token preserved when server doesn't send a new one
	if saved.RefreshToken != "my-refresh" {
		t.Errorf("saved refresh_token = %q, want preserved %q", saved.RefreshToken, "my-refresh")
	}
}

func TestOAuth2ToolRefreshWithNewRefreshToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{
			"access_token": "new-access",
			"refresh_token": "new-refresh",
			"token_type": "Bearer",
			"expires_in": 3600
		}`)
	}))
	defer srv.Close()

	store := newMemStore()
	store.tokens["google"] = &credentials.OAuth2Token{
		AccessToken:  "old",
		RefreshToken: "old-refresh",
		Expiry:       time.Now().Add(-time.Hour),
	}

	tool := NewOAuth2ToolWithClient([]config.OAuth2Config{
		{Name: "google", ClientID: "id", ClientSecret: "secret", TokenURL: srv.URL},
	}, store, srv.Client())

	_, err := tool.Run(context.Background(), json.RawMessage(`{"provider": "google"}`))
	if err != nil {
		t.Fatal(err)
	}

	saved := store.tokens["google"]
	if saved.RefreshToken != "new-refresh" {
		t.Errorf("refresh_token = %q, want %q", saved.RefreshToken, "new-refresh")
	}
}

func TestOAuth2ToolRefreshFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		fmt.Fprintf(w, `{"error": "invalid_grant"}`)
	}))
	defer srv.Close()

	store := newMemStore()
	store.tokens["google"] = &credentials.OAuth2Token{
		AccessToken:  "expired",
		RefreshToken: "bad-refresh",
		Expiry:       time.Now().Add(-time.Hour),
	}

	tool := NewOAuth2ToolWithClient([]config.OAuth2Config{
		{Name: "google", ClientID: "id", ClientSecret: "secret", TokenURL: srv.URL},
	}, store, srv.Client())

	_, err := tool.Run(context.Background(), json.RawMessage(`{"provider": "google"}`))
	if err == nil {
		t.Error("expected error on failed refresh")
	}
}

func TestOAuth2ToolExpiredNoRefresh(t *testing.T) {
	store := newMemStore()
	store.tokens["google"] = &credentials.OAuth2Token{
		AccessToken: "expired",
		Expiry:      time.Now().Add(-time.Hour),
		// No refresh token
	}

	tool := NewOAuth2Tool([]config.OAuth2Config{
		{Name: "google"},
	}, store)

	_, err := tool.Run(context.Background(), json.RawMessage(`{"provider": "google"}`))
	if err == nil {
		t.Error("expected error with no refresh token")
	}
}

func TestOAuth2ToolHasProvider(t *testing.T) {
	tool := NewOAuth2Tool([]config.OAuth2Config{
		{Name: "google"},
		{Name: "microsoft"},
	}, newMemStore())

	if !tool.HasProvider("google") {
		t.Error("should have google")
	}
	if !tool.HasProvider("microsoft") {
		t.Error("should have microsoft")
	}
	if tool.HasProvider("github") {
		t.Error("should not have github")
	}
}
