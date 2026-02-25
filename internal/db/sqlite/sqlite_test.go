package sqlite_test

import (
	"context"
	"path/filepath"
	"testing"

	"smithly.dev/internal/db"
	"smithly.dev/internal/db/sqlite"
	"smithly.dev/internal/db/storetest"
)

func newTestStore(t *testing.T) db.Store {
	t.Helper()
	dir := t.TempDir()
	store, err := sqlite.New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("sqlite.New: %v", err)
	}
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func TestSQLiteConformance(t *testing.T) {
	storetest.RunAll(t, newTestStore)
}
