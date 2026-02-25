package tools

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseRobotsTxt(t *testing.T) {
	tests := []struct {
		name      string
		robotsTxt string
		path      string
		want      bool
	}{
		{
			name:      "empty robots.txt allows all",
			robotsTxt: "",
			path:      "/anything",
			want:      true,
		},
		{
			name:      "disallow all for wildcard",
			robotsTxt: "User-agent: *\nDisallow: /",
			path:      "/page",
			want:      false,
		},
		{
			name:      "disallow specific path",
			robotsTxt: "User-agent: *\nDisallow: /private/",
			path:      "/private/secrets",
			want:      false,
		},
		{
			name:      "allow non-matching path",
			robotsTxt: "User-agent: *\nDisallow: /private/",
			path:      "/public/page",
			want:      true,
		},
		{
			name:      "specific bot override",
			robotsTxt: "User-agent: *\nDisallow: /\n\nUser-agent: Smithly\nDisallow:\nAllow: /",
			path:      "/page",
			want:      true,
		},
		{
			name:      "specific bot blocked",
			robotsTxt: "User-agent: Smithly\nDisallow: /",
			path:      "/anything",
			want:      false,
		},
		{
			name:      "allow overrides disallow same length",
			robotsTxt: "User-agent: *\nDisallow: /page\nAllow: /page",
			path:      "/page",
			want:      true,
		},
		{
			name:      "longer disallow wins",
			robotsTxt: "User-agent: *\nAllow: /page\nDisallow: /page/secret",
			path:      "/page/secret",
			want:      false,
		},
		{
			name:      "longer allow wins",
			robotsTxt: "User-agent: *\nDisallow: /page\nAllow: /page/public",
			path:      "/page/public/file",
			want:      true,
		},
		{
			name:      "wildcard pattern",
			robotsTxt: "User-agent: *\nDisallow: /*.json",
			path:      "/api/data.json",
			want:      false,
		},
		{
			name:      "wildcard allows non-match",
			robotsTxt: "User-agent: *\nDisallow: /*.json",
			path:      "/api/data.html",
			want:      true,
		},
		{
			name:      "dollar anchor exact match",
			robotsTxt: "User-agent: *\nDisallow: /exact$",
			path:      "/exact",
			want:      false,
		},
		{
			name:      "dollar anchor no match on prefix",
			robotsTxt: "User-agent: *\nDisallow: /exact$",
			path:      "/exact/more",
			want:      true,
		},
		{
			name:      "case insensitive agent match",
			robotsTxt: "User-agent: smithly\nDisallow: /",
			path:      "/page",
			want:      false,
		},
		{
			name:      "root path",
			robotsTxt: "User-agent: *\nDisallow: /admin",
			path:      "/",
			want:      true,
		},
		{
			name:      "comments ignored",
			robotsTxt: "# Block all bots\nUser-agent: * # all bots\nDisallow: /secret # keep out",
			path:      "/secret/stuff",
			want:      false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rules := parseRobotsTxt(strings.NewReader(tt.robotsTxt))
			got := rules.isAllowed(tt.path)
			if got != tt.want {
				t.Errorf("isAllowed(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestRobotsCheckerWithServer(t *testing.T) {
	// Server that returns a robots.txt blocking /private/
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/robots.txt" {
			fmt.Fprint(w, "User-agent: *\nDisallow: /private/\n")
			return
		}
		fmt.Fprint(w, "OK")
	}))
	defer srv.Close()

	rc := NewRobotsChecker(srv.Client())
	ctx := context.Background()

	// Public page should be allowed
	ok, err := rc.Allowed(ctx, srv.URL+"/public/page")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !ok {
		t.Error("expected /public/page to be allowed")
	}

	// Private page should be blocked
	ok, err = rc.Allowed(ctx, srv.URL+"/private/data")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if ok {
		t.Error("expected /private/data to be blocked")
	}
}

func TestRobotsCheckerNoRobotsTxt(t *testing.T) {
	// Server with no robots.txt (404)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	rc := NewRobotsChecker(srv.Client())
	ctx := context.Background()

	ok, err := rc.Allowed(ctx, srv.URL+"/anything")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !ok {
		t.Error("expected everything allowed when no robots.txt")
	}
}

func TestRobotsCheckerCaching(t *testing.T) {
	fetchCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/robots.txt" {
			fetchCount++
			fmt.Fprint(w, "User-agent: *\nAllow: /\n")
		}
	}))
	defer srv.Close()

	rc := NewRobotsChecker(srv.Client())
	ctx := context.Background()

	// Multiple calls should only fetch robots.txt once
	for i := 0; i < 5; i++ {
		rc.Allowed(ctx, srv.URL+"/page"+fmt.Sprintf("%d", i))
	}

	if fetchCount != 1 {
		t.Errorf("robots.txt fetched %d times, want 1 (caching broken)", fetchCount)
	}
}

func TestRobotsPatternMatch(t *testing.T) {
	tests := []struct {
		path    string
		pattern string
		want    bool
	}{
		{"/foo/bar", "/foo", true},
		{"/foo/bar", "/baz", false},
		{"/api/data.json", "/*.json", true},
		{"/api/data.html", "/*.json", false},
		{"/page", "/page$", true},
		{"/page/more", "/page$", false},
		{"/foo/bar/baz.php", "/*.php$", true},
		{"/foo/bar/baz.php/x", "/*.php$", false},
		{"/", "/", true},
		{"/anything", "/", true},
	}

	for _, tt := range tests {
		t.Run(tt.path+"_"+tt.pattern, func(t *testing.T) {
			got := robotsPatternMatch(tt.path, tt.pattern)
			if got != tt.want {
				t.Errorf("robotsPatternMatch(%q, %q) = %v, want %v",
					tt.path, tt.pattern, got, tt.want)
			}
		})
	}
}
