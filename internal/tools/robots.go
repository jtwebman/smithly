package tools

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const botName = "Smithly"

// RobotsChecker fetches and caches robots.txt files per origin,
// then checks whether a URL path is allowed for our user-agent.
// On any error (missing robots.txt, network failure, parse error)
// it defaults to allowing the request.
type RobotsChecker struct {
	client *http.Client
	cache  map[string]*robotsEntry
	mu     sync.Mutex
	ttl    time.Duration
}

type robotsEntry struct {
	rules     robotsRules
	fetchedAt time.Time
}

type robotsRules struct {
	disallow []string
	allow    []string
}

func NewRobotsChecker(client *http.Client) *RobotsChecker {
	return &RobotsChecker{
		client: client,
		cache:  make(map[string]*robotsEntry),
		ttl:    1 * time.Hour,
	}
}

// Allowed checks robots.txt for the given URL.
// Returns (true, nil) if allowed or if robots.txt can't be determined.
// Returns (false, nil) if explicitly disallowed.
func (rc *RobotsChecker) Allowed(ctx context.Context, rawURL string) (bool, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false, fmt.Errorf("parse URL: %w", err)
	}

	origin := parsed.Scheme + "://" + parsed.Host
	rules := rc.getRules(ctx, origin)

	return rules.isAllowed(parsed.Path), nil
}

func (rc *RobotsChecker) getRules(ctx context.Context, origin string) robotsRules {
	rc.mu.Lock()
	if entry, ok := rc.cache[origin]; ok && time.Since(entry.fetchedAt) < rc.ttl {
		rules := entry.rules
		rc.mu.Unlock()
		return rules
	}
	rc.mu.Unlock()

	rules := rc.fetchRobots(ctx, origin)

	rc.mu.Lock()
	rc.cache[origin] = &robotsEntry{rules: rules, fetchedAt: time.Now()}
	rc.mu.Unlock()

	return rules
}

func (rc *RobotsChecker) fetchRobots(ctx context.Context, origin string) robotsRules {
	robotsURL := origin + "/robots.txt"
	req, err := http.NewRequestWithContext(ctx, "GET", robotsURL, http.NoBody)
	if err != nil {
		return robotsRules{} // allow all
	}
	req.Header.Set("User-Agent", botName+"/0.1")

	resp, err := rc.client.Do(req)
	if err != nil {
		return robotsRules{} // allow all
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return robotsRules{} // no robots.txt = allow all
	}

	limited := io.LimitReader(resp.Body, 512*1024)
	return parseRobotsTxt(limited)
}

// parseRobotsTxt extracts rules for our bot name or the "*" wildcard.
// If there is a section specifically for our bot, those rules take priority.
func parseRobotsTxt(r io.Reader) robotsRules {
	scanner := bufio.NewScanner(r)

	var (
		inOurGroup      bool
		inWildcardGroup bool

		ourDisallow      []string
		ourAllow         []string
		wildcardDisallow []string
		wildcardAllow    []string
		foundOurs        bool
	)

	ourName := strings.ToLower(botName)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		// Strip comments
		if idx := strings.Index(line, "#"); idx >= 0 {
			line = strings.TrimSpace(line[:idx])
		}
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}

		directive := strings.TrimSpace(strings.ToLower(parts[0]))
		value := strings.TrimSpace(parts[1])

		switch directive {
		case "user-agent":
			agent := strings.ToLower(value)
			switch {
			case agent == "*":
				inWildcardGroup = true
				inOurGroup = false
			case agent == ourName || strings.HasPrefix(ourName, agent):
				inOurGroup = true
				inWildcardGroup = false
				foundOurs = true
			default:
				inOurGroup = false
				inWildcardGroup = false
			}

		case "disallow":
			if value == "" {
				continue
			}
			if inOurGroup {
				ourDisallow = append(ourDisallow, value)
			} else if inWildcardGroup {
				wildcardDisallow = append(wildcardDisallow, value)
			}

		case "allow":
			if value == "" {
				continue
			}
			if inOurGroup {
				ourAllow = append(ourAllow, value)
			} else if inWildcardGroup {
				wildcardAllow = append(wildcardAllow, value)
			}
		}
	}

	if foundOurs {
		return robotsRules{disallow: ourDisallow, allow: ourAllow}
	}
	return robotsRules{disallow: wildcardDisallow, allow: wildcardAllow}
}

// isAllowed checks a path against the disallow/allow rules.
// Most-specific (longest) matching rule wins; on a tie, allow wins.
func (r *robotsRules) isAllowed(path string) bool {
	if path == "" {
		path = "/"
	}

	bestAllow := -1
	for _, pattern := range r.allow {
		if robotsPatternMatch(path, pattern) && len(pattern) > bestAllow {
			bestAllow = len(pattern)
		}
	}

	bestDisallow := -1
	for _, pattern := range r.disallow {
		if robotsPatternMatch(path, pattern) && len(pattern) > bestDisallow {
			bestDisallow = len(pattern)
		}
	}

	if bestAllow == -1 && bestDisallow == -1 {
		return true // no matching rules
	}

	return bestAllow >= bestDisallow
}

// robotsPatternMatch handles prefix matching with optional * wildcards and $ anchor.
func robotsPatternMatch(path, pattern string) bool {
	anchored := strings.HasSuffix(pattern, "$")
	if anchored {
		pattern = pattern[:len(pattern)-1]
	}

	if !strings.Contains(pattern, "*") {
		if anchored {
			return path == pattern
		}
		return strings.HasPrefix(path, pattern)
	}

	// Wildcard matching: split on *, each segment must appear in order
	parts := strings.Split(pattern, "*")
	remaining := path
	for i, part := range parts {
		if part == "" {
			continue
		}
		if i == 0 {
			if !strings.HasPrefix(remaining, part) {
				return false
			}
			remaining = remaining[len(part):]
		} else {
			idx := strings.Index(remaining, part)
			if idx < 0 {
				return false
			}
			remaining = remaining[idx+len(part):]
		}
	}
	if anchored {
		return remaining == ""
	}
	return true
}
