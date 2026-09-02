// Package store provides the local-first persistence layer: a single JSON
// document written atomically, with debounced flushes and a mutex-guarded
// in-memory copy. No database engine is required, which keeps the runtime
// small and the on-disk format inspectable.
package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"melo/internal/model"
)

const (
	stateVersion   = 1
	maxHistory     = 500
	maxStats       = 400
	maxDisliked    = 200
	maxSearchTerms = 50
)

var ErrNotFound = errors.New("not found")

type Store struct {
	mu    sync.RWMutex
	dir   string
	state model.AppState

	flushMu    sync.Mutex
	flushTimer *time.Timer
	closed     bool
}

// Open loads the state document from dir, creating defaults when absent.
// A corrupt document is preserved as <file>.corrupt and replaced with defaults
// rather than silently discarded.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	s := &Store{dir: dir, state: model.AppState{
		Settings: model.DefaultSettings(),
		Version:  stateVersion,
	}}
	raw, err := os.ReadFile(s.path())
	switch {
	case errors.Is(err, os.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, fmt.Errorf("read state: %w", err)
	}
	var loaded model.AppState
	if err := json.Unmarshal(raw, &loaded); err != nil {
		_ = os.Rename(s.path(), s.path()+".corrupt")
		return s, nil
	}
	s.state = migrate(loaded)
	return s, nil
}

func migrate(st model.AppState) model.AppState {
	def := model.DefaultSettings()
	if st.Settings.Theme == "" {
		st.Settings.Theme = def.Theme
	}
	if st.Settings.Accent == "" {
		st.Settings.Accent = def.Accent
	}
	if st.Settings.DefaultSpeed <= 0 {
		st.Settings.DefaultSpeed = def.DefaultSpeed
	}
	if st.Settings.AudioQuality == "" {
		st.Settings.AudioQuality = def.AudioQuality
	}
	if st.Settings.Volume <= 0 {
		st.Settings.Volume = def.Volume
	}
	if st.Settings.Shortcuts == nil {
		st.Settings.Shortcuts = def.Shortcuts
	} else {
		for k, v := range def.Shortcuts {
			if _, ok := st.Settings.Shortcuts[k]; !ok {
				st.Settings.Shortcuts[k] = v
			}
		}
	}
	if st.Playlists == nil {
		st.Playlists = []model.Playlist{}
	}
	if st.Liked == nil {
		st.Liked = []model.Track{}
	}
	if st.Disliked == nil {
		st.Disliked = []model.Track{}
	}
	if st.Stats == nil {
		st.Stats = map[string]model.PlayStats{}
	}
	if st.History == nil {
		st.History = []model.PlayRecord{}
	}
	if st.SearchHistory == nil {
		st.SearchHistory = []string{}
	}
	st.Version = stateVersion
	return st
}

func (s *Store) path() string { return filepath.Join(s.dir, "melo-state.json") }
func (s *Store) Dir() string  { return s.dir }

// State returns a deep-enough copy for the frontend boot payload.
func (s *Store) State() model.AppState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := s.state
	st.Liked = append([]model.Track(nil), s.state.Liked...)
	st.Disliked = append([]model.Track(nil), s.state.Disliked...)
	st.Playlists = append([]model.Playlist(nil), s.state.Playlists...)
	st.History = append([]model.PlayRecord(nil), s.state.History...)
	st.SearchHistory = append([]string(nil), s.state.SearchHistory...)
	if s.state.Stats != nil {
		st.Stats = make(map[string]model.PlayStats, len(s.state.Stats))
		for k, v := range s.state.Stats {
			st.Stats[k] = v
		}
	}
	return st
}

func (s *Store) mutate(fn func(st *model.AppState)) {
	s.mu.Lock()
	fn(&s.state)
	s.mu.Unlock()
	s.scheduleFlush()
}

// scheduleFlush coalesces rapid writes into one disk write (250ms debounce).
func (s *Store) scheduleFlush() {
	s.flushMu.Lock()
	defer s.flushMu.Unlock()
	if s.closed {
		return
	}
	if s.flushTimer != nil {
		s.flushTimer.Stop()
	}
	s.flushTimer = time.AfterFunc(250*time.Millisecond, func() {
		if err := s.Flush(); err != nil {
			fmt.Fprintf(os.Stderr, "melo: state flush failed: %v\n", err)
		}
	})
}

// Flush writes the state document atomically (temp file + rename).
func (s *Store) Flush() error {
	s.mu.RLock()
	raw, err := json.MarshalIndent(s.state, "", "  ")
	s.mu.RUnlock()
	if err != nil {
		return err
	}
	tmp := s.path() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path())
}

// Close flushes pending writes and stops the debounce timer.
func (s *Store) Close() error {
	s.flushMu.Lock()
	s.closed = true
	if s.flushTimer != nil {
		s.flushTimer.Stop()
	}
	s.flushMu.Unlock()
	return s.Flush()
}

// ---------- settings ----------

func (s *Store) SaveSettings(in model.Settings) model.Settings {
	if in.DefaultSpeed < 0.25 || in.DefaultSpeed > 3 {
		in.DefaultSpeed = 1
	}
	if in.Volume < 0 {
		in.Volume = 0
	}
	if in.Volume > 1 {
		in.Volume = 1
	}
	if in.Shortcuts == nil {
		in.Shortcuts = model.DefaultSettings().Shortcuts
	}
	s.mutate(func(st *model.AppState) { st.Settings = in })
	return in
}

// ---------- likes ----------

func (s *Store) SetLiked(t model.Track, liked bool) []model.Track {
	s.mutate(func(st *model.AppState) {
		idx := indexOfTrack(st.Liked, t.ID)
		if liked {
			if idx == -1 {
				t.AddedAt = time.Now().UnixMilli()
				st.Liked = append([]model.Track{t}, st.Liked...)
			}
			return
		}
		if idx >= 0 {
			st.Liked = append(st.Liked[:idx], st.Liked[idx+1:]...)
		}
	})
	return s.State().Liked
}

func (s *Store) IsLiked(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return indexOfTrack(s.state.Liked, id) >= 0
}

// ---------- dislikes (don't recommend) ----------

// SetDisliked records or clears "don't recommend this song" feedback. Dislike
// is local only and never touches the liked list; the renderer keeps the two
// mutually exclusive so the intent is unambiguous.
func (s *Store) SetDisliked(t model.Track, disliked bool) []model.Track {
	s.mutate(func(st *model.AppState) {
		idx := indexOfTrack(st.Disliked, t.ID)
		if disliked {
			if idx == -1 {
				t.AddedAt = time.Now().UnixMilli()
				st.Disliked = append([]model.Track{t}, st.Disliked...)
				if len(st.Disliked) > maxDisliked {
					st.Disliked = st.Disliked[:maxDisliked]
				}
			}
			return
		}
		if idx >= 0 {
			st.Disliked = append(st.Disliked[:idx], st.Disliked[idx+1:]...)
		}
	})
	return s.State().Disliked
}

func (s *Store) IsDisliked(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return indexOfTrack(s.state.Disliked, id) >= 0
}

// ---------- history & listening events ----------

// RecordPlay appends a real playback event. Consecutive duplicates within
// 30 seconds are collapsed so a seek-heavy session does not spam history.
func (s *Store) RecordPlay(t model.Track) []model.PlayRecord {
	s.RecordPlayEvent(t, model.PlayStarted)
	return s.State().History
}

// Taste returns the full personalisation payload: listening history, the
// per-track play statistics and the dislike list.
func (s *Store) Taste() model.Taste {
	st := s.State()
	return model.Taste{History: st.History, Stats: st.Stats, Disliked: st.Disliked}
}

// RecordPlayEvent applies one listening event. Only play_started touches the
// visible history (with the same 30s collapse as before); every event updates
// the bounded per-track statistics that feed recommendations:
//
//	play_started         PlayCount++, LastPlayedAt
//	played_significantly SignificantCount++
//	completed            CompleteCount++
//	skipped              SkipCount++
//
// Unknown events are ignored so a newer renderer talking to an older store
// degrades gracefully rather than corrupting the document.
func (s *Store) RecordPlayEvent(t model.Track, event string) model.Taste {
	if t.ID == "" {
		return s.Taste()
	}
	now := time.Now().UnixMilli()
	apply := func(st *model.AppState) {
		if st.Stats == nil {
			st.Stats = map[string]model.PlayStats{}
		}
		stats := st.Stats[t.ID]
		switch event {
		case model.PlayStarted:
			stats.PlayCount++
			stats.LastPlayedAt = now
		case model.PlayedSignificantly:
			stats.SignificantCount++
		case model.PlayCompleted:
			stats.CompleteCount++
		case model.PlaySkipped:
			stats.SkipCount++
		default:
			return
		}
		st.Stats[t.ID] = stats
		trimStats(st)
		if event != model.PlayStarted {
			return
		}
		if len(st.History) > 0 {
			last := st.History[0]
			if last.Track.ID == t.ID && now-last.PlayedAt < 30_000 {
				st.History[0].PlayedAt = now
				return
			}
		}
		st.History = append([]model.PlayRecord{{Track: t, PlayedAt: now}}, st.History...)
		if len(st.History) > maxHistory {
			st.History = st.History[:maxHistory]
		}
	}
	s.mutate(apply)
	return s.Taste()
}

// trimStats keeps the statistics map bounded, evicting the least recently
// played entries first so long-term favourites survive.
func trimStats(st *model.AppState) {
	if len(st.Stats) <= maxStats {
		return
	}
	type kv struct {
		id   string
		last int64
	}
	entries := make([]kv, 0, len(st.Stats))
	for id, s := range st.Stats {
		entries = append(entries, kv{id, s.LastPlayedAt})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].last > entries[j].last })
	for _, e := range entries[maxStats:] {
		delete(st.Stats, e.id)
	}
}

func (s *Store) ClearHistory() {
	s.mutate(func(st *model.AppState) { st.History = []model.PlayRecord{} })
}

// ---------- search history ----------

func (s *Store) AddSearchTerm(q string) []string {
	q = strings.TrimSpace(q)
	if q == "" {
		return s.State().SearchHistory
	}
	s.mutate(func(st *model.AppState) {
		out := []string{q}
		for _, existing := range st.SearchHistory {
			if !strings.EqualFold(existing, q) {
				out = append(out, existing)
			}
		}
		if len(out) > maxSearchTerms {
			out = out[:maxSearchTerms]
		}
		st.SearchHistory = out
	})
	return s.State().SearchHistory
}

func (s *Store) RemoveSearchTerm(q string) []string {
	s.mutate(func(st *model.AppState) {
		out := st.SearchHistory[:0]
		for _, existing := range st.SearchHistory {
			if !strings.EqualFold(existing, q) {
				out = append(out, existing)
			}
		}
		st.SearchHistory = append([]string{}, out...)
	})
	return s.State().SearchHistory
}

func (s *Store) ClearSearchHistory() {
	s.mutate(func(st *model.AppState) { st.SearchHistory = []string{} })
}

// ---------- playlists ----------

func (s *Store) CreatePlaylist(name string, tracks []model.Track) model.Playlist {
	now := time.Now().UnixMilli()
	pl := model.Playlist{
		ID:        newID("pl"),
		Name:      strings.TrimSpace(name),
		Tracks:    dedupeTracks(tracks),
		CreatedAt: now,
		UpdatedAt: now,
	}
	if pl.Name == "" {
		pl.Name = "New Playlist"
	}
	if pl.Tracks == nil {
		pl.Tracks = []model.Track{}
	}
	s.mutate(func(st *model.AppState) { st.Playlists = append(st.Playlists, pl) })
	return pl
}

func (s *Store) withPlaylist(id string, fn func(pl *model.Playlist)) (model.Playlist, error) {
	var out model.Playlist
	var found bool
	s.mutate(func(st *model.AppState) {
		for i := range st.Playlists {
			if st.Playlists[i].ID == id {
				fn(&st.Playlists[i])
				st.Playlists[i].UpdatedAt = time.Now().UnixMilli()
				out = st.Playlists[i]
				found = true
				return
			}
		}
	})
	if !found {
		return out, ErrNotFound
	}
	return out, nil
}

func (s *Store) RenamePlaylist(id, name string) (model.Playlist, error) {
	return s.withPlaylist(id, func(pl *model.Playlist) {
		if n := strings.TrimSpace(name); n != "" {
			pl.Name = n
		}
	})
}

func (s *Store) DeletePlaylist(id string) error {
	var found bool
	s.mutate(func(st *model.AppState) {
		out := st.Playlists[:0]
		for _, pl := range st.Playlists {
			if pl.ID == id {
				found = true
				continue
			}
			out = append(out, pl)
		}
		st.Playlists = append([]model.Playlist{}, out...)
	})
	if !found {
		return ErrNotFound
	}
	return nil
}

func (s *Store) AddTracksToPlaylist(id string, tracks []model.Track) (model.Playlist, error) {
	return s.withPlaylist(id, func(pl *model.Playlist) {
		for _, t := range tracks {
			if indexOfTrack(pl.Tracks, t.ID) >= 0 {
				continue
			}
			t.AddedAt = time.Now().UnixMilli()
			pl.Tracks = append(pl.Tracks, t)
		}
	})
}

func (s *Store) RemoveTrackFromPlaylist(id string, index int) (model.Playlist, error) {
	return s.withPlaylist(id, func(pl *model.Playlist) {
		if index < 0 || index >= len(pl.Tracks) {
			return
		}
		pl.Tracks = append(pl.Tracks[:index], pl.Tracks[index+1:]...)
	})
}

func (s *Store) ReorderPlaylist(id string, from, to int) (model.Playlist, error) {
	return s.withPlaylist(id, func(pl *model.Playlist) {
		pl.Tracks = Reorder(pl.Tracks, from, to)
	})
}

func (s *Store) DuplicatePlaylist(id string) (model.Playlist, error) {
	s.mu.RLock()
	var src *model.Playlist
	for i := range s.state.Playlists {
		if s.state.Playlists[i].ID == id {
			cp := s.state.Playlists[i]
			src = &cp
			break
		}
	}
	s.mu.RUnlock()
	if src == nil {
		return model.Playlist{}, ErrNotFound
	}
	return s.CreatePlaylist(src.Name+" (copy)", append([]model.Track(nil), src.Tracks...)), nil
}

// ---------- session ----------

func (s *Store) SaveSession(sess model.Session) {
	sess.SavedAt = time.Now().UnixMilli()
	s.mutate(func(st *model.AppState) { st.Session = &sess })
}

func (s *Store) ClearSession() { s.mutate(func(st *model.AppState) { st.Session = nil }) }

// ---------- derived library views ----------

// LibraryTracks returns the deduplicated union of liked songs, playlist tracks
// and played history — the "Songs" view. Nothing is fabricated.
func (s *Store) LibraryTracks() []model.Track {
	s.mu.RLock()
	defer s.mu.RUnlock()
	seen := map[string]bool{}
	var out []model.Track
	add := func(t model.Track) {
		if t.ID == "" || seen[t.ID] {
			return
		}
		seen[t.ID] = true
		out = append(out, t)
	}
	for _, t := range s.state.Liked {
		add(t)
	}
	for _, pl := range s.state.Playlists {
		for _, t := range pl.Tracks {
			add(t)
		}
	}
	for _, h := range s.state.History {
		add(h.Track)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
	})
	if out == nil {
		out = []model.Track{}
	}
	return out
}

// ---------- helpers ----------

// newID returns a collision-free identifier even when several objects are
// created within the same millisecond.
func newID(prefix string) string {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return fmt.Sprintf("%s_%d_%s", prefix, time.Now().UnixMilli(), hex.EncodeToString(b[:]))
}

func indexOfTrack(list []model.Track, id string) int {
	for i, t := range list {
		if t.ID == id {
			return i
		}
	}
	return -1
}

func dedupeTracks(in []model.Track) []model.Track {
	seen := map[string]bool{}
	out := make([]model.Track, 0, len(in))
	for _, t := range in {
		if t.ID == "" || seen[t.ID] {
			continue
		}
		seen[t.ID] = true
		out = append(out, t)
	}
	return out
}

// Reorder moves the element at from to index to, preserving the rest.
func Reorder[T any](list []T, from, to int) []T {
	if from < 0 || from >= len(list) || to < 0 || to >= len(list) || from == to {
		return list
	}
	out := make([]T, 0, len(list))
	item := list[from]
	for i, v := range list {
		if i == from {
			continue
		}
		out = append(out, v)
	}
	rest := make([]T, 0, len(list))
	rest = append(rest, out[:to]...)
	rest = append(rest, item)
	rest = append(rest, out[to:]...)
	return rest
}
