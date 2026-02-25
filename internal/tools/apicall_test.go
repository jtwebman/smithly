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

func TestAPICallBasicGET(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Errorf("method = %q, want GET", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status": "ok"}`)
	}))
	defer srv.Close()

	api := NewAPICallWithClient(nil, srv.Client())

	if api.Name() != "api_call" {
		t.Errorf("name = %q", api.Name())
	}
	if !api.NeedsApproval() {
		t.Error("NeedsApproval should be true")
	}

	result, err := api.Run(context.Background(), json.RawMessage(fmt.Sprintf(`{"url": %q}`, srv.URL)))
	if err != nil {
		t.Fatal(err)
	}
	if result != `{"status": "ok"}` {
		t.Errorf("result = %q", result)
	}
}

func TestAPICallPOST(t *testing.T) {
	var gotBody string
	var gotContentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method = %q, want POST", r.Method)
		}
		gotContentType = r.Header.Get("Content-Type")
		buf := make([]byte, 1024)
		n, _ := r.Body.Read(buf)
		gotBody = string(buf[:n])
		w.WriteHeader(201)
		fmt.Fprintf(w, `{"id": 42}`)
	}))
	defer srv.Close()

	api := NewAPICallWithClient(nil, srv.Client())
	result, err := api.Run(context.Background(), json.RawMessage(fmt.Sprintf(`{
		"url": %q,
		"method": "POST",
		"body": "{\"name\": \"test\"}"
	}`, srv.URL)))
	if err != nil {
		t.Fatal(err)
	}
	if gotBody != `{"name": "test"}` {
		t.Errorf("body = %q", gotBody)
	}
	if gotContentType != "application/json" {
		t.Errorf("content-type = %q, want application/json", gotContentType)
	}
	if result != `{"id": 42}` {
		t.Errorf("result = %q", result)
	}
}

func TestAPICallCustomHeaders(t *testing.T) {
	var gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAccept = r.Header.Get("Accept")
		fmt.Fprintf(w, "ok")
	}))
	defer srv.Close()

	api := NewAPICallWithClient(nil, srv.Client())
	_, err := api.Run(context.Background(), json.RawMessage(fmt.Sprintf(`{
		"url": %q,
		"headers": {"Accept": "text/plain"}
	}`, srv.URL)))
	if err != nil {
		t.Fatal(err)
	}
	if gotAccept != "text/plain" {
		t.Errorf("Accept = %q", gotAccept)
	}
}

func TestAPICallWithOAuth2(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		fmt.Fprintf(w, "authenticated")
	}))
	defer srv.Close()

	store := newMemStore()
	store.tokens["google"] = &credentials.OAuth2Token{
		AccessToken: "my-token",
		Expiry:      time.Now().Add(time.Hour),
	}

	oauth2 := NewOAuth2ToolWithClient([]config.OAuth2Config{
		{Name: "google"},
	}, store, srv.Client())

	api := NewAPICallWithClient(oauth2, srv.Client())
	result, err := api.Run(context.Background(), json.RawMessage(fmt.Sprintf(`{
		"url": %q,
		"oauth2_provider": "google"
	}`, srv.URL)))
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer my-token" {
		t.Errorf("auth = %q, want %q", gotAuth, "Bearer my-token")
	}
	if result != "authenticated" {
		t.Errorf("result = %q", result)
	}
}

func TestAPICallNoOAuth2Configured(t *testing.T) {
	api := NewAPICall(nil)

	_, err := api.Run(context.Background(), json.RawMessage(`{
		"url": "http://example.com",
		"oauth2_provider": "google"
	}`))
	if err == nil {
		t.Error("expected error when no OAuth2 configured")
	}
}

func TestAPICallHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		fmt.Fprintf(w, `{"error": "not found"}`)
	}))
	defer srv.Close()

	api := NewAPICallWithClient(nil, srv.Client())
	result, err := api.Run(context.Background(), json.RawMessage(fmt.Sprintf(`{"url": %q}`, srv.URL)))
	if err != nil {
		t.Fatal(err)
	}
	// Non-2xx includes status in response
	if result == "" {
		t.Error("expected non-empty result")
	}
	if !contains(result, "404") {
		t.Errorf("result should contain 404: %q", result)
	}
}

func TestAPICallHTMLStripping(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, "<html><body><p>Hello</p></body></html>")
	}))
	defer srv.Close()

	api := NewAPICallWithClient(nil, srv.Client())
	result, err := api.Run(context.Background(), json.RawMessage(fmt.Sprintf(`{"url": %q}`, srv.URL)))
	if err != nil {
		t.Fatal(err)
	}
	if contains(result, "<html>") {
		t.Errorf("HTML should be stripped: %q", result)
	}
	if !contains(result, "Hello") {
		t.Errorf("should contain text: %q", result)
	}
}

func TestAPICallDefaultMethod(t *testing.T) {
	var gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		fmt.Fprintf(w, "ok")
	}))
	defer srv.Close()

	api := NewAPICallWithClient(nil, srv.Client())
	_, err := api.Run(context.Background(), json.RawMessage(fmt.Sprintf(`{"url": %q}`, srv.URL)))
	if err != nil {
		t.Fatal(err)
	}
	if gotMethod != "GET" {
		t.Errorf("method = %q, want GET (default)", gotMethod)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsStr(s, substr))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
