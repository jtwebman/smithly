package credentials

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	store := NewFileStore(path)
	ctx := context.Background()

	// Put a token
	token := &OAuth2Token{
		AccessToken:  "access-123",
		RefreshToken: "refresh-456",
		TokenType:    "Bearer",
		Expiry:       time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC),
	}
	if err := store.Put(ctx, "google", token); err != nil {
		t.Fatal(err)
	}

	// Get it back
	got, err := store.Get(ctx, "google")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("expected token, got nil")
	}
	if got.AccessToken != "access-123" {
		t.Errorf("access_token = %q, want %q", got.AccessToken, "access-123")
	}
	if got.RefreshToken != "refresh-456" {
		t.Errorf("refresh_token = %q, want %q", got.RefreshToken, "refresh-456")
	}
	if got.TokenType != "Bearer" {
		t.Errorf("token_type = %q, want %q", got.TokenType, "Bearer")
	}
	if !got.Expiry.Equal(token.Expiry) {
		t.Errorf("expiry = %v, want %v", got.Expiry, token.Expiry)
	}
}

func TestFileStoreGetMissing(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(filepath.Join(dir, "credentials.json"))

	got, err := store.Get(context.Background(), "nonexistent")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Errorf("expected nil for missing provider, got %+v", got)
	}
}

func TestFileStoreDelete(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(filepath.Join(dir, "credentials.json"))
	ctx := context.Background()

	store.Put(ctx, "google", &OAuth2Token{AccessToken: "a"})
	store.Put(ctx, "microsoft", &OAuth2Token{AccessToken: "b"})

	if err := store.Delete(ctx, "google"); err != nil {
		t.Fatal(err)
	}

	got, _ := store.Get(ctx, "google")
	if got != nil {
		t.Error("expected nil after delete")
	}

	got, _ = store.Get(ctx, "microsoft")
	if got == nil {
		t.Error("microsoft should still exist")
	}
}

func TestFileStoreDeleteMissing(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(filepath.Join(dir, "credentials.json"))

	// Deleting a missing key should not error
	if err := store.Delete(context.Background(), "nope"); err != nil {
		t.Fatal(err)
	}
}

func TestFileStoreList(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(filepath.Join(dir, "credentials.json"))
	ctx := context.Background()

	store.Put(ctx, "microsoft", &OAuth2Token{AccessToken: "b"})
	store.Put(ctx, "google", &OAuth2Token{AccessToken: "a"})

	names, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 {
		t.Fatalf("len = %d, want 2", len(names))
	}
	// Should be sorted
	if names[0] != "google" || names[1] != "microsoft" {
		t.Errorf("names = %v, want [google, microsoft]", names)
	}
}

func TestFileStoreListEmpty(t *testing.T) {
	dir := t.TempDir()
	store := NewFileStore(filepath.Join(dir, "credentials.json"))

	names, err := store.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Errorf("expected empty list, got %v", names)
	}
}

func TestFileStorePermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	store := NewFileStore(path)

	store.Put(context.Background(), "test", &OAuth2Token{AccessToken: "x"})

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	perm := info.Mode().Perm()
	if perm != 0600 {
		t.Errorf("permissions = %o, want 0600", perm)
	}
}

func TestFileStorePersistence(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")

	// Write with one store instance
	s1 := NewFileStore(path)
	s1.Put(context.Background(), "google", &OAuth2Token{AccessToken: "persisted"})

	// Read with a new instance
	s2 := NewFileStore(path)
	got, err := s2.Get(context.Background(), "google")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.AccessToken != "persisted" {
		t.Errorf("expected persisted token, got %+v", got)
	}
}

func TestOAuth2TokenValid(t *testing.T) {
	// Empty token
	tok := &OAuth2Token{}
	if tok.Valid() {
		t.Error("empty token should not be valid")
	}

	// Token with no expiry — always valid
	tok = &OAuth2Token{AccessToken: "abc"}
	if !tok.Valid() {
		t.Error("token with no expiry should be valid")
	}

	// Token expiring in the future
	tok = &OAuth2Token{
		AccessToken: "abc",
		Expiry:      time.Now().Add(time.Hour),
	}
	if !tok.Valid() {
		t.Error("future token should be valid")
	}

	// Token expired
	tok = &OAuth2Token{
		AccessToken: "abc",
		Expiry:      time.Now().Add(-time.Hour),
	}
	if tok.Valid() {
		t.Error("expired token should not be valid")
	}

	// Token expiring within 30 seconds (grace period)
	tok = &OAuth2Token{
		AccessToken: "abc",
		Expiry:      time.Now().Add(10 * time.Second),
	}
	if tok.Valid() {
		t.Error("token expiring within grace period should not be valid")
	}
}
