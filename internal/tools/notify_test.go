package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

type mockNotifyProvider struct {
	lastTitle    string
	lastMessage  string
	lastPriority int
	err          error
}

func (m *mockNotifyProvider) Name() string { return "mock" }
func (m *mockNotifyProvider) Send(_ context.Context, title, message string, priority int) error {
	m.lastTitle = title
	m.lastMessage = message
	m.lastPriority = priority
	return m.err
}

func TestNotifyBasic(t *testing.T) {
	mock := &mockNotifyProvider{}
	n := NewNotify(mock)

	if n.Name() != "notify" {
		t.Errorf("name = %q, want %q", n.Name(), "notify")
	}
	if n.NeedsApproval() {
		t.Error("NeedsApproval should be false")
	}

	result, err := n.Run(context.Background(), json.RawMessage(`{
		"title": "Test Alert",
		"message": "Something happened",
		"priority": 4
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if mock.lastTitle != "Test Alert" {
		t.Errorf("title = %q, want %q", mock.lastTitle, "Test Alert")
	}
	if mock.lastMessage != "Something happened" {
		t.Errorf("message = %q, want %q", mock.lastMessage, "Something happened")
	}
	if mock.lastPriority != 4 {
		t.Errorf("priority = %d, want 4", mock.lastPriority)
	}
	if result != "Notification sent via mock: Test Alert" {
		t.Errorf("result = %q", result)
	}
}

func TestNotifyDefaultPriority(t *testing.T) {
	mock := &mockNotifyProvider{}
	n := NewNotify(mock)

	_, err := n.Run(context.Background(), json.RawMessage(`{
		"title": "Hi",
		"message": "Default priority"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if mock.lastPriority != 3 {
		t.Errorf("priority = %d, want 3 (default)", mock.lastPriority)
	}
}

func TestNotifyValidation(t *testing.T) {
	mock := &mockNotifyProvider{}
	n := NewNotify(mock)

	tests := []struct {
		name string
		args string
	}{
		{"missing title", `{"message": "hi"}`},
		{"missing message", `{"title": "hi"}`},
		{"priority too high", `{"title": "hi", "message": "hi", "priority": 6}`},
	}
	for _, tt := range tests {
		_, err := n.Run(context.Background(), json.RawMessage(tt.args))
		if err == nil {
			t.Errorf("%s: expected error", tt.name)
		}
	}
}

func TestNotifyProviderError(t *testing.T) {
	mock := &mockNotifyProvider{err: fmt.Errorf("connection refused")}
	n := NewNotify(mock)

	_, err := n.Run(context.Background(), json.RawMessage(`{
		"title": "Fail",
		"message": "Should error"
	}`))
	if err == nil {
		t.Error("expected error from provider")
	}
}

func TestNtfyProvider(t *testing.T) {
	var gotTitle, gotBody, gotPriority string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			t.Errorf("method = %q, want POST", r.Method)
		}
		if r.URL.Path != "/test-topic" {
			t.Errorf("path = %q, want /test-topic", r.URL.Path)
		}
		gotTitle = r.Header.Get("Title")
		gotPriority = r.Header.Get("Priority")

		buf := make([]byte, 1024)
		n, _ := r.Body.Read(buf)
		gotBody = string(buf[:n])

		w.WriteHeader(200)
	}))
	defer srv.Close()

	p := NewNtfyProviderWithClient("test-topic", srv.URL, srv.Client())

	if p.Name() != "ntfy" {
		t.Errorf("name = %q, want %q", p.Name(), "ntfy")
	}

	err := p.Send(context.Background(), "Server Down", "Check it out", 5)
	if err != nil {
		t.Fatal(err)
	}

	if gotTitle != "Server Down" {
		t.Errorf("title = %q, want %q", gotTitle, "Server Down")
	}
	if gotBody != "Check it out" {
		t.Errorf("body = %q, want %q", gotBody, "Check it out")
	}
	if gotPriority != "5" {
		t.Errorf("priority = %q, want %q", gotPriority, "5")
	}
}

func TestNtfyProviderHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer srv.Close()

	p := NewNtfyProviderWithClient("test", srv.URL, srv.Client())
	err := p.Send(context.Background(), "Fail", "msg", 3)
	if err == nil {
		t.Error("expected error for HTTP 500")
	}
}

func TestNtfyProviderDefaultServer(t *testing.T) {
	p := NewNtfyProvider("my-topic", "")
	if p.server != "https://ntfy.sh" {
		t.Errorf("server = %q, want %q", p.server, "https://ntfy.sh")
	}
}
