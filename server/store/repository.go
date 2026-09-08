// Package store defines the account-scoped persistence boundary used by the
// hosted API. FileRepository is the zero-dependency development implementation;
// a PostgreSQL implementation can satisfy the same interfaces without changing
// API handlers or the React client.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"melo/internal/model"
	localstore "melo/internal/store"
)

type Library interface {
	State() model.AppState
	SaveSettings(model.Settings) model.Settings
	SetLiked(model.Track, bool) []model.Track
	RecordPlay(model.Track) []model.PlayRecord
	ClearHistory()
	AddSearchTerm(string) []string
	RemoveSearchTerm(string) []string
	ClearSearchHistory()
	LibraryTracks() []model.Track
	SaveSession(model.Session)
	ClearSession()
	CreatePlaylist(string, []model.Track) model.Playlist
	RenamePlaylist(string, string) (model.Playlist, error)
	DeletePlaylist(string) error
	AddTracksToPlaylist(string, []model.Track) (model.Playlist, error)
	RemoveTrackFromPlaylist(string, int) (model.Playlist, error)
	ReorderPlaylist(string, int, int) (model.Playlist, error)
	DuplicatePlaylist(string) (model.Playlist, error)
}

type Repository interface {
	ForSubject(context.Context, string) (Library, error)
	Ready(context.Context) error
	Close() error
}

type FileRepository struct {
	root string
	mu   sync.Mutex
	open map[string]*localstore.Store
}

func NewFileRepository(root string) *FileRepository {
	return &FileRepository{root: filepath.Join(root, "accounts"), open: make(map[string]*localstore.Store)}
}

func (r *FileRepository) ForSubject(_ context.Context, subject string) (Library, error) {
	if subject == "" {
		return nil, fmt.Errorf("missing account subject")
	}
	digest := sha256.Sum256([]byte(subject))
	key := hex.EncodeToString(digest[:])
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing := r.open[key]; existing != nil {
		return existing, nil
	}
	opened, err := localstore.Open(filepath.Join(r.root, key))
	if err != nil {
		return nil, err
	}
	r.open[key] = opened
	return opened, nil
}

func (r *FileRepository) Ready(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	if err := os.MkdirAll(r.root, 0o700); err != nil {
		return fmt.Errorf("create account storage: %w", err)
	}
	probe, err := os.CreateTemp(r.root, ".ready-*")
	if err != nil {
		return fmt.Errorf("account storage is not writable: %w", err)
	}
	name := probe.Name()
	if err := probe.Close(); err != nil {
		_ = os.Remove(name)
		return fmt.Errorf("close storage readiness probe: %w", err)
	}
	if err := os.Remove(name); err != nil {
		return fmt.Errorf("remove storage readiness probe: %w", err)
	}
	return nil
}

func (r *FileRepository) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	var first error
	for key, opened := range r.open {
		if err := opened.Close(); err != nil && first == nil {
			first = err
		}
		delete(r.open, key)
	}
	return first
}
