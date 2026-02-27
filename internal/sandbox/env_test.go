package sandbox

import (
	"strings"
	"testing"
	"time"

	"smithly.dev/internal/config"
	"smithly.dev/internal/skills"
)

type mockSidecar struct {
	url     string
	revoked bool
}

func (m *mockSidecar) IssueToken(skill string, ttl time.Duration) string {
	return "mock-token-" + skill
}

func (m *mockSidecar) RevokeToken(token string) {
	m.revoked = true
}

func (m *mockSidecar) URL() string {
	return m.url
}

var _ skills.SidecarIface = (*mockSidecar)(nil)

func TestBuildEnvSidecar(t *testing.T) {
	sc := &mockSidecar{url: "http://127.0.0.1:18791"}
	ec := EnvConfig{Sidecar: sc}
	base := []string{"PATH=/usr/bin"}

	env, token := BuildEnv(ec, "test-skill", 30*time.Second, base)

	if token != "mock-token-test-skill" {
		t.Errorf("token = %q, want %q", token, "mock-token-test-skill")
	}

	assertEnvContains(t, env, "PATH=/usr/bin")
	assertEnvContains(t, env, "SMITHLY_API=http://127.0.0.1:18791")
	assertEnvContains(t, env, "SMITHLY_TOKEN=mock-token-test-skill")
}

func TestBuildEnvDataStores(t *testing.T) {
	ec := EnvConfig{
		DataStores: []config.DataStoreConfig{
			{Type: "sqlite", Path: "/data/store.db"},
			{Type: "postgres", URL: "postgres://localhost/db"},
		},
	}

	env, token := BuildEnv(ec, "test", 30*time.Second, nil)

	if token != "" {
		t.Errorf("expected empty token without sidecar, got %q", token)
	}

	assertEnvContains(t, env, "SMITHLY_SQLITE_PATH=/data/store.db")
	assertEnvContains(t, env, "SMITHLY_POSTGRES_URL=postgres://localhost/db")
	assertEnvContains(t, env, "SMITHLY_DB_TYPE=sqlite")
}

func TestBuildEnvProxy(t *testing.T) {
	ec := EnvConfig{ProxyAddr: "127.0.0.1:18792"}

	env, _ := BuildEnv(ec, "test", 30*time.Second, nil)

	expected := "http://127.0.0.1:18792"
	assertEnvContains(t, env, "HTTP_PROXY="+expected)
	assertEnvContains(t, env, "HTTPS_PROXY="+expected)
	assertEnvContains(t, env, "http_proxy="+expected)
	assertEnvContains(t, env, "https_proxy="+expected)
}

func TestBuildEnvCombined(t *testing.T) {
	sc := &mockSidecar{url: "http://127.0.0.1:18791"}
	ec := EnvConfig{
		Sidecar:    sc,
		DataStores: []config.DataStoreConfig{{Type: "sqlite", Path: "/data/store.db"}},
		ProxyAddr:  "127.0.0.1:18792",
	}

	env, token := BuildEnv(ec, "myskill", 10*time.Second, []string{"PATH=/usr/bin"})

	if token == "" {
		t.Error("expected non-empty token")
	}
	assertEnvContains(t, env, "PATH=/usr/bin")
	assertEnvContains(t, env, "SMITHLY_API=http://127.0.0.1:18791")
	assertEnvContains(t, env, "SMITHLY_SQLITE_PATH=/data/store.db")
	assertEnvContains(t, env, "HTTP_PROXY=http://127.0.0.1:18792")
}

func TestBuildEnvEmpty(t *testing.T) {
	ec := EnvConfig{}
	env, token := BuildEnv(ec, "test", 30*time.Second, nil)

	if token != "" {
		t.Errorf("expected empty token, got %q", token)
	}
	if len(env) != 0 {
		t.Errorf("expected empty env, got %v", env)
	}
}

func assertEnvContains(t *testing.T, env []string, want string) {
	t.Helper()
	for _, e := range env {
		if e == want {
			return
		}
	}
	t.Errorf("env missing %q\ngot: %s", want, strings.Join(env, ", "))
}
