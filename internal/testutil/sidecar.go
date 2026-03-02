package testutil

import "time"

// MockSidecar implements skills.SidecarIface for testing.
type MockSidecar struct {
	SidecarURL string
	Revoked    bool
}

func (m *MockSidecar) IssueToken(skill string, ttl time.Duration) string {
	return "mock-token-" + skill
}

func (m *MockSidecar) RevokeToken(token string) {
	m.Revoked = true
}

func (m *MockSidecar) URL() string {
	return m.SidecarURL
}
