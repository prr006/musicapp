package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestFileRepositoryReadinessProbesPersistentStorage(t *testing.T) {
	root := t.TempDir()
	repository := NewFileRepository(root)
	if err := repository.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "accounts"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("readiness probe left files behind: %v", entries)
	}
}
