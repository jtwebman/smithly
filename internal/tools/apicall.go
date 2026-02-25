package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// APICall makes HTTP requests with optional OAuth2 authentication.
type APICall struct {
	oauth2 *OAuth2Tool
	client *http.Client
}

func NewAPICall(oauth2 *OAuth2Tool) *APICall {
	return &APICall{
		oauth2: oauth2,
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

// NewAPICallWithClient creates an APICall with a custom HTTP client (for testing).
func NewAPICallWithClient(oauth2 *OAuth2Tool, client *http.Client) *APICall {
	return &APICall{
		oauth2: oauth2,
		client: client,
	}
}

func (a *APICall) Name() string { return "api_call" }
func (a *APICall) Description() string {
	return "Make an HTTP request to an API. Supports OAuth2 authentication via configured providers."
}
func (a *APICall) NeedsApproval() bool { return true }

func (a *APICall) Parameters() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"url": {
				"type": "string",
				"description": "The URL to call"
			},
			"method": {
				"type": "string",
				"description": "HTTP method (default GET)",
				"enum": ["GET", "POST", "PUT", "DELETE", "PATCH"]
			},
			"oauth2_provider": {
				"type": "string",
				"description": "OAuth2 provider name for authentication"
			},
			"headers": {
				"type": "object",
				"description": "Additional HTTP headers"
			},
			"body": {
				"type": "string",
				"description": "Request body (for POST/PUT/PATCH)"
			}
		},
		"required": ["url"]
	}`)
}

func (a *APICall) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		URL            string            `json:"url"`
		Method         string            `json:"method"`
		OAuth2Provider string            `json:"oauth2_provider"`
		Headers        map[string]string `json:"headers"`
		Body           string            `json:"body"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("parse args: %w", err)
	}
	if params.URL == "" {
		return "", fmt.Errorf("url is required")
	}
	if params.Method == "" {
		params.Method = "GET"
	}

	// Build request
	var bodyReader io.Reader
	if params.Body != "" {
		bodyReader = strings.NewReader(params.Body)
	}

	req, err := http.NewRequestWithContext(ctx, params.Method, params.URL, bodyReader)
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}

	// Set custom headers
	for k, v := range params.Headers {
		req.Header.Set(k, v)
	}

	// Set auth header from OAuth2 if provider specified
	if params.OAuth2Provider != "" {
		if a.oauth2 == nil {
			return "", fmt.Errorf("no OAuth2 providers configured")
		}
		token, err := a.oauth2.GetToken(ctx, params.OAuth2Provider)
		if err != nil {
			return "", err
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}

	// Default content type for requests with body
	if params.Body != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	// Read response (limit to 50KB)
	body, err := io.ReadAll(io.LimitReader(resp.Body, 50*1024))
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}

	content := string(body)

	// Strip HTML if response is HTML
	contentType := resp.Header.Get("Content-Type")
	if strings.Contains(contentType, "text/html") {
		content = stripHTML(content)
	}

	// Include status code in response for non-2xx
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Sprintf("HTTP %d %s\n\n%s", resp.StatusCode, resp.Status, content), nil
	}

	return content, nil
}
