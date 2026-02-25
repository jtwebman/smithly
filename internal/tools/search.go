package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// SearchProvider implementations handle the actual search API call.
type SearchProvider interface {
	Search(ctx context.Context, query string) (*SearchResults, error)
	Name() string
}

// SearchResults are returned by a provider and tracked so read_url can verify origin.
type SearchResults struct {
	Query   string
	Results []SearchResult
}

type SearchResult struct {
	Title       string
	URL         string
	Description string
}

// Search performs web searches and reads URLs from search results.
// This is a trusted built-in tool — no approval needed.
// The tool tracks which URLs came from search results. Only those URLs
// can be read via the "read" action, preventing the agent from using
// this tool to read arbitrary domains.
// Respects robots.txt on read — use the browse tool to bypass.
type Search struct {
	provider   SearchProvider
	client     *http.Client
	robots     *RobotsChecker
	knownURLs  map[string]bool // URLs that appeared in search results
	mu         sync.Mutex
}

func NewSearch() *Search {
	client := &http.Client{}
	return &Search{
		provider:  &DuckDuckGoSearch{client: client},
		client:    client,
		robots:    NewRobotsChecker(client),
		knownURLs: make(map[string]bool),
	}
}

func NewSearchWithProvider(p SearchProvider) *Search {
	client := &http.Client{}
	return &Search{
		provider:  p,
		client:    client,
		robots:    NewRobotsChecker(client),
		knownURLs: make(map[string]bool),
	}
}

// NewSearchWithProviderAndClient creates a Search with custom provider and HTTP client (for testing).
func NewSearchWithProviderAndClient(p SearchProvider, client *http.Client) *Search {
	return &Search{
		provider:  p,
		client:    client,
		robots:    NewRobotsChecker(client),
		knownURLs: make(map[string]bool),
	}
}

func (s *Search) Name() string { return "search" }
func (s *Search) Description() string {
	return fmt.Sprintf(`Search the web using %s. Two actions:
- "search": Run a web search query and get results (titles, URLs, descriptions).
- "read": Read the full content of a URL that appeared in search results.
Use search first, then read specific results for details.`, s.provider.Name())
}
func (s *Search) NeedsApproval() bool { return false }

func (s *Search) Parameters() json.RawMessage {
	return json.RawMessage(`{
		"type": "object",
		"properties": {
			"action": {
				"type": "string",
				"enum": ["search", "read"],
				"description": "Action to perform: 'search' for a web query, 'read' to fetch a URL from previous search results"
			},
			"query": {
				"type": "string",
				"description": "The search query (required for action=search)"
			},
			"url": {
				"type": "string",
				"description": "URL to read (required for action=read, must be from previous search results)"
			}
		},
		"required": ["action"]
	}`)
}

func (s *Search) Run(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Action string `json:"action"`
		Query  string `json:"query"`
		URL    string `json:"url"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("parse args: %w", err)
	}

	switch params.Action {
	case "search":
		return s.doSearch(ctx, params.Query)
	case "read":
		return s.doRead(ctx, params.URL)
	default:
		return "", fmt.Errorf("unknown action %q, use 'search' or 'read'", params.Action)
	}
}

func (s *Search) doSearch(ctx context.Context, query string) (string, error) {
	if query == "" {
		return "", fmt.Errorf("query is required for search action")
	}

	results, err := s.provider.Search(ctx, query)
	if err != nil {
		return "", err
	}

	if len(results.Results) == 0 {
		return fmt.Sprintf("No results found for %q.", query), nil
	}

	// Track all result URLs as trusted for future read calls
	s.mu.Lock()
	for _, r := range results.Results {
		s.knownURLs[r.URL] = true
	}
	s.mu.Unlock()

	var out strings.Builder
	fmt.Fprintf(&out, "Search results for: %s\n\n", query)
	for i, r := range results.Results {
		fmt.Fprintf(&out, "%d. %s\n   %s\n   %s\n\n", i+1, r.Title, r.URL, r.Description)
	}
	out.WriteString("Use action='read' with a URL above to read the full page content.")
	return out.String(), nil
}

func (s *Search) doRead(ctx context.Context, rawURL string) (string, error) {
	if rawURL == "" {
		return "", fmt.Errorf("url is required for read action")
	}

	// Verify this URL came from search results
	s.mu.Lock()
	allowed := s.knownURLs[rawURL]
	s.mu.Unlock()

	if !allowed {
		return "", fmt.Errorf("URL %q was not in search results. Use action='search' first, then read URLs from the results", rawURL)
	}

	// Check robots.txt
	robotsOK, err := s.robots.Allowed(ctx, rawURL)
	if err != nil {
		return "", fmt.Errorf("robots check: %w", err)
	}
	if !robotsOK {
		return fmt.Sprintf("Blocked by robots.txt: %s", rawURL), nil
	}

	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", botName+"/0.1")
	req.Header.Set("Accept", "text/html, text/plain, application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("HTTP %d: %s", resp.StatusCode, resp.Status), nil
	}

	limited := io.LimitReader(resp.Body, 100*1024)
	body, err := io.ReadAll(limited)
	if err != nil {
		return "", fmt.Errorf("read body: %w", err)
	}

	content := string(body)
	contentType := resp.Header.Get("Content-Type")
	if strings.Contains(contentType, "text/html") {
		content = stripHTML(content)
	}

	return content, nil
}

// --- Brave Search ---

type BraveSearch struct {
	APIKey string
	client *http.Client
}

func NewBraveSearch(apiKey string) *BraveSearch {
	return &BraveSearch{APIKey: apiKey, client: &http.Client{}}
}

func (b *BraveSearch) Name() string { return "Brave Search" }

func (b *BraveSearch) Search(ctx context.Context, query string) (*SearchResults, error) {
	u := "https://api.search.brave.com/res/v1/web/search?q=" + url.QueryEscape(query) + "&count=10"

	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Subscription-Token", b.APIKey)

	resp, err := b.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("brave search: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == 401 || resp.StatusCode == 403 || resp.StatusCode == 422 {
		return nil, fmt.Errorf("brave search: invalid API key (HTTP %d). Get one free at https://brave.com/search/api/", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("brave search returned %d: %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var apiResp struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"results"`
		} `json:"web"`
	}
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, fmt.Errorf("parse brave response: %w", err)
	}

	results := &SearchResults{Query: query}
	for _, r := range apiResp.Web.Results {
		results.Results = append(results.Results, SearchResult{
			Title:       r.Title,
			URL:         r.URL,
			Description: r.Description,
		})
	}
	return results, nil
}

// --- DuckDuckGo (fallback, no API key needed) ---

type DuckDuckGoSearch struct {
	client *http.Client
}

func NewDuckDuckGoSearch() *DuckDuckGoSearch {
	return &DuckDuckGoSearch{client: &http.Client{}}
}

func (d *DuckDuckGoSearch) Name() string { return "DuckDuckGo" }

func (d *DuckDuckGoSearch) Search(ctx context.Context, query string) (*SearchResults, error) {
	u := "https://api.duckduckgo.com/?q=" + url.QueryEscape(query) + "&format=json&no_html=1"
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", botName+"/0.1")

	resp, err := d.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("duckduckgo: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var apiResp struct {
		Abstract       string `json:"Abstract"`
		AbstractSource string `json:"AbstractSource"`
		AbstractURL    string `json:"AbstractURL"`
		Answer         string `json:"Answer"`
		RelatedTopics  []struct {
			Text     string `json:"Text"`
			FirstURL string `json:"FirstURL"`
		} `json:"RelatedTopics"`
	}
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, err
	}

	results := &SearchResults{Query: query}
	if apiResp.AbstractURL != "" {
		results.Results = append(results.Results, SearchResult{
			Title:       apiResp.AbstractSource,
			URL:         apiResp.AbstractURL,
			Description: apiResp.Abstract,
		})
	}
	for _, topic := range apiResp.RelatedTopics {
		if topic.FirstURL != "" {
			results.Results = append(results.Results, SearchResult{
				Title:       "",
				URL:         topic.FirstURL,
				Description: topic.Text,
			})
		}
	}
	return results, nil
}
