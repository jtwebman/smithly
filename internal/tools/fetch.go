package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// Fetch reads a URL and returns its content as text. GET only.
// Respects robots.txt — use the browse tool to bypass for opted-in users.
type Fetch struct {
	client *http.Client
	robots *RobotsChecker
}

func NewFetch() *Fetch {
	client := &http.Client{}
	return &Fetch{
		client: client,
		robots: NewRobotsChecker(client),
	}
}

// NewFetchWithClient creates a Fetch tool with a custom HTTP client (for testing).
func NewFetchWithClient(client *http.Client) *Fetch {
	return &Fetch{
		client: client,
		robots: NewRobotsChecker(client),
	}
}

func (f *Fetch) Name() string { return "fetch" }
func (f *Fetch) Description() string {
	return "Fetch a URL and return its content as text. GET only. Respects robots.txt. For URLs from search results, use the search tool's read action instead (no approval needed)."
}
func (f *Fetch) NeedsApproval() bool { return true }

func (f *Fetch) Parameters() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"url": {
				"type": "string",
				"description": "The URL to fetch"
			}
		},
		"required": ["url"]
	}`)
}

func (f *Fetch) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("parse args: %w", err)
	}
	if params.URL == "" {
		return "", fmt.Errorf("url is required")
	}

	// Check robots.txt
	allowed, err := f.robots.Allowed(ctx, params.URL)
	if err != nil {
		return "", fmt.Errorf("robots check: %w", err)
	}
	if !allowed {
		return fmt.Sprintf("Blocked by robots.txt: %s", params.URL), nil
	}

	req, err := http.NewRequestWithContext(ctx, "GET", params.URL, nil)
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", botName+"/0.1")
	req.Header.Set("Accept", "text/html, text/plain, application/json")

	resp, err := f.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("HTTP %d: %s", resp.StatusCode, resp.Status), nil
	}

	// Limit read to 100KB
	limited := io.LimitReader(resp.Body, 100*1024)
	body, err := io.ReadAll(limited)
	if err != nil {
		return "", fmt.Errorf("read body: %w", err)
	}

	content := string(body)

	// If HTML, do a basic strip to make it readable
	contentType := resp.Header.Get("Content-Type")
	if strings.Contains(contentType, "text/html") {
		content = stripHTML(content)
	}

	return content, nil
}

var (
	reScript = regexp.MustCompile(`(?is)<script.*?</script>`)
	reStyle  = regexp.MustCompile(`(?is)<style.*?</style>`)
	reTag    = regexp.MustCompile(`<[^>]*>`)
	reSpaces = regexp.MustCompile(`\n{3,}`)
)

func stripHTML(html string) string {
	s := reScript.ReplaceAllString(html, "")
	s = reStyle.ReplaceAllString(s, "")
	s = reTag.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", "\"")
	s = strings.ReplaceAll(s, "&#39;", "'")
	s = strings.ReplaceAll(s, "&nbsp;", " ")
	// Collapse excessive whitespace
	lines := strings.Split(s, "\n")
	var trimmed []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			trimmed = append(trimmed, line)
		}
	}
	s = strings.Join(trimmed, "\n")
	s = reSpaces.ReplaceAllString(s, "\n\n")
	// Truncate if still huge
	if len(s) > 50000 {
		s = s[:50000] + "\n\n[truncated]"
	}
	return s
}
