// Package webhook implements the inbound webhook HTTP server.
// It receives push events from external services and routes them to agents.
package webhook

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"time"

	"smithly.dev/internal/agent"
	"smithly.dev/internal/channels"
	"smithly.dev/internal/db"
)

// maxBodySize is the maximum allowed webhook payload size (1 MB).
const maxBodySize = 1 << 20

// WebhookConfig defines a named inbound webhook endpoint.
type WebhookConfig struct {
	Name        string
	Secret      string
	AgentID     string
	AutoApprove bool
}

// Server is the webhook HTTP server.
type Server struct {
	Bind     string
	Port     int
	Webhooks map[string]*WebhookConfig // name → config
	Store    db.Store
	Agents   channels.AgentGetter
	server   *http.Server
}

// Handler returns the HTTP handler with webhook routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /w/{name}", s.handleWebhook)
	mux.HandleFunc("GET /health", s.handleHealth)
	return mux
}

// Start begins serving HTTP on the configured address.
func (s *Server) Start() error {
	addr := fmt.Sprintf("%s:%d", s.Bind, s.Port)
	s.server = &http.Server{
		Addr:         addr,
		Handler:      s.Handler(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 5 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}

	slog.Info("webhook server listening", "addr", addr)
	return s.server.Serve(ln)
}

// Shutdown gracefully stops the server.
func (s *Server) Shutdown(ctx context.Context) error {
	if s.server != nil {
		return s.server.Shutdown(ctx)
	}
	return nil
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "ok"}); err != nil {
		slog.Error("health response write failed", "err", err)
	}
}

func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")

	wh, ok := s.Webhooks[name]
	if !ok {
		http.Error(w, "unknown webhook", http.StatusNotFound)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodySize))
	if err != nil {
		http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
		return
	}

	// Check HMAC signature
	sig := r.Header.Get("X-Hub-Signature-256")
	if sig == "" {
		sig = r.Header.Get("X-Signature-256")
	}
	sigValid := VerifySignature(body, wh.Secret, sig)

	// Encode request headers as JSON
	headersJSON, _ := json.Marshal(r.Header)

	sourceIP := r.RemoteAddr
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		sourceIP = fwd
	}

	// Log to database
	entry := &db.WebhookEntry{
		Webhook:        name,
		Headers:        string(headersJSON),
		Body:           string(body),
		SourceIP:       sourceIP,
		SignatureValid: sigValid,
		AgentID:        wh.AgentID,
	}
	if err := s.Store.LogWebhook(r.Context(), entry); err != nil {
		slog.Error("failed to log webhook", "webhook", name, "err", err)
	}

	// Reject if signature is invalid (only when secret is configured)
	if wh.Secret != "" && !sigValid {
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}

	// Accept immediately
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "accepted"}); err != nil {
		slog.Error("webhook response write failed", "err", err)
	}

	// Process async: look up agent and send message
	go s.processWebhook(wh, string(body), name)
}

func (s *Server) processWebhook(wh *WebhookConfig, body, name string) {
	a, ok := s.Agents.GetAgent(wh.AgentID)
	if !ok {
		slog.Error("webhook agent not found", "webhook", name, "agent", wh.AgentID)
		return
	}

	cb := &agent.Callbacks{
		Source: "webhook:" + name,
		Trust:  "semi-trusted",
	}
	if wh.AutoApprove {
		cb.Approve = func(string, string) bool { return true }
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	if _, err := a.Chat(ctx, body, cb); err != nil {
		slog.Error("webhook agent chat failed", "webhook", name, "agent", wh.AgentID, "err", err)
	}
}
