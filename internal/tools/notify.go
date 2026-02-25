package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// NotifyProvider sends notifications through a specific channel (ntfy, Slack, etc.)
type NotifyProvider interface {
	Name() string
	Send(ctx context.Context, title, message string, priority int) error
}

// Notify is a tool that sends push notifications via a pluggable provider.
type Notify struct {
	provider NotifyProvider
}

func NewNotify(provider NotifyProvider) *Notify {
	return &Notify{provider: provider}
}

func (n *Notify) Name() string { return "notify" }
func (n *Notify) Description() string {
	return "Send a push notification. Use for alerts, reminders, or status updates."
}
func (n *Notify) NeedsApproval() bool { return false }

func (n *Notify) Parameters() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"title": {
				"type": "string",
				"description": "Notification title"
			},
			"message": {
				"type": "string",
				"description": "Notification body text"
			},
			"priority": {
				"type": "integer",
				"description": "Priority 1-5 (1=min, 3=default, 5=urgent)"
			}
		},
		"required": ["title", "message"]
	}`)
}

func (n *Notify) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Title    string `json:"title"`
		Message  string `json:"message"`
		Priority int    `json:"priority"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("parse args: %w", err)
	}
	if params.Title == "" {
		return "", fmt.Errorf("title is required")
	}
	if params.Message == "" {
		return "", fmt.Errorf("message is required")
	}
	if params.Priority == 0 {
		params.Priority = 3
	}
	if params.Priority < 1 || params.Priority > 5 {
		return "", fmt.Errorf("priority must be 1-5")
	}

	if err := n.provider.Send(ctx, params.Title, params.Message, params.Priority); err != nil {
		return "", fmt.Errorf("send notification: %w", err)
	}

	return fmt.Sprintf("Notification sent via %s: %s", n.provider.Name(), params.Title), nil
}

// NtfyProvider sends notifications via ntfy.sh (or a self-hosted ntfy server).
type NtfyProvider struct {
	topic  string
	server string
	client *http.Client
}

func NewNtfyProvider(topic, server string) *NtfyProvider {
	if server == "" {
		server = "https://ntfy.sh"
	}
	return &NtfyProvider{
		topic:  topic,
		server: strings.TrimRight(server, "/"),
		client: &http.Client{},
	}
}

// NewNtfyProviderWithClient creates an NtfyProvider with a custom HTTP client (for testing).
func NewNtfyProviderWithClient(topic, server string, client *http.Client) *NtfyProvider {
	p := NewNtfyProvider(topic, server)
	p.client = client
	return p
}

func (p *NtfyProvider) Name() string { return "ntfy" }

func (p *NtfyProvider) Send(ctx context.Context, title, message string, priority int) error {
	url := fmt.Sprintf("%s/%s", p.server, p.topic)

	req, err := http.NewRequestWithContext(ctx, "POST", url, strings.NewReader(message))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Title", title)
	req.Header.Set("Priority", fmt.Sprintf("%d", priority))

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("send: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("ntfy returned HTTP %d", resp.StatusCode)
	}

	return nil
}
