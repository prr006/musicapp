package store

import (
	"os"
	"path/filepath"
	"testing"

	"melo/internal/model"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, dir
}

func track(id string) model.Track {
	return model.Track{ID: id, SourceID: id, Source: "youtube", Title: "Song " + id, Artist: "Artist"}
}

func TestDefaultsAndPersistence(t *testing.T) {
	s, dir := newStore(t)
	if s.State().Settings.Theme != "dark" {
		t.Fatalf("expected default dark theme")
	}
	s.SetLiked(track("a"), true)
	set := model.DefaultSettings()
	set.Theme = "light"
	set.Volume = 0.42
	s.SaveSettings(set)
	pl := s.CreatePlaylist("Focus", []model.Track{track("a"), track("b")})
	s.RecordPlay(track("b"))
	s.AddSearchTerm("nujabes")
	if err := s.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	st := reopened.State()
	if len(st.Liked) != 1 || st.Liked[0].ID != "a" {
		t.Fatalf("likes did not survive restart: %+v", st.Liked)
	}
	if st.Settings.Theme != "light" || st.Settings.Volume != 0.42 {
		t.Fatalf("settings did not survive restart: %+v", st.Settings)
	}
	if len(st.Playlists) != 1 || st.Playlists[0].ID != pl.ID || len(st.Playlists[0].Tracks) != 2 {
		t.Fatalf("playlists did not survive restart: %+v", st.Playlists)
	}
	if len(st.History) != 1 || st.History[0].Track.ID != "b" {
		t.Fatalf("history did not survive restart: %+v", st.History)
	}
	if len(st.SearchHistory) != 1 {
		t.Fatalf("search history did not survive restart")
	}
}

func TestCorruptStateIsQuarantined(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "melo-state.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	if _, err := os.Stat(path + ".corrupt"); err != nil {
		t.Fatalf("expected corrupt file to be preserved: %v", err)
	}
	if s.State().Settings.Theme != "dark" {
		t.Fatalf("expected defaults after corruption")
	}
}

func TestLikeToggleIsIdempotent(t *testing.T) {
	s, _ := newStore(t)
	s.SetLiked(track("a"), true)
	s.SetLiked(track("a"), true)
	if got := len(s.State().Liked); got != 1 {
		t.Fatalf("expected 1 like, got %d", got)
	}
	if !s.IsLiked("a") {
		t.Fatal("expected a to be liked")
	}
	s.SetLiked(track("a"), false)
	if s.IsLiked("a") {
		t.Fatal("expected a to be unliked")
	}
}

func TestHistoryCollapsesRepeats(t *testing.T) {
	s, _ := newStore(t)
	s.RecordPlay(track("a"))
	s.RecordPlay(track("a"))
	if got := len(s.State().History); got != 1 {
		t.Fatalf("expected repeated play to collapse, got %d entries", got)
	}
	s.RecordPlay(track("b"))
	h := s.State().History
	if len(h) != 2 || h[0].Track.ID != "b" {
		t.Fatalf("expected newest first, got %+v", h)
	}
}

func TestSearchHistoryDedupesAndOrders(t *testing.T) {
	s, _ := newStore(t)
	s.AddSearchTerm("aphex twin")
	s.AddSearchTerm("boards of canada")
	s.AddSearchTerm("Aphex Twin")
	got := s.State().SearchHistory
	if len(got) != 2 || got[0] != "Aphex Twin" {
		t.Fatalf("unexpected search history: %+v", got)
	}
	s.RemoveSearchTerm("aphex twin")
	if len(s.State().SearchHistory) != 1 {
		t.Fatalf("remove failed: %+v", s.State().SearchHistory)
	}
	s.ClearSearchHistory()
	if len(s.State().SearchHistory) != 0 {
		t.Fatal("clear failed")
	}
}

func TestPlaylistLifecycle(t *testing.T) {
	s, _ := newStore(t)
	pl := s.CreatePlaylist("  ", nil)
	if pl.Name != "New Playlist" {
		t.Fatalf("expected fallback name, got %q", pl.Name)
	}
	if _, err := s.RenamePlaylist(pl.ID, "Late Night"); err != nil {
		t.Fatal(err)
	}
	got, err := s.AddTracksToPlaylist(pl.ID, []model.Track{track("a"), track("b"), track("a")})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tracks) != 2 {
		t.Fatalf("expected duplicates to be ignored, got %d", len(got.Tracks))
	}
	got, _ = s.AddTracksToPlaylist(pl.ID, []model.Track{track("c")})
	got, err = s.ReorderPlaylist(pl.ID, 2, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Tracks[0].ID != "c" || got.Tracks[1].ID != "a" || got.Tracks[2].ID != "b" {
		t.Fatalf("reorder wrong: %v", ids(got.Tracks))
	}
	got, err = s.RemoveTrackFromPlaylist(pl.ID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Tracks) != 2 || got.Tracks[1].ID != "b" {
		t.Fatalf("remove wrong: %v", ids(got.Tracks))
	}
	dup, err := s.DuplicatePlaylist(pl.ID)
	if err != nil {
		t.Fatal(err)
	}
	if dup.Name != "Late Night (copy)" || len(dup.Tracks) != 2 {
		t.Fatalf("duplicate wrong: %+v", dup)
	}
	if err := s.DeletePlaylist(pl.ID); err != nil {
		t.Fatal(err)
	}
	if len(s.State().Playlists) != 1 {
		t.Fatalf("delete wrong: %+v", s.State().Playlists)
	}
	if err := s.DeletePlaylist("nope"); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestReorderEdgeCases(t *testing.T) {
	in := []string{"a", "b", "c"}
	if got := Reorder(in, 0, 5); len(got) != 3 || got[0] != "a" {
		t.Fatalf("out-of-range reorder should be a no-op: %v", got)
	}
	if got := Reorder(in, 0, 2); got[2] != "a" {
		t.Fatalf("expected a to move last: %v", got)
	}
}

func TestLibraryTracksUnion(t *testing.T) {
	s, _ := newStore(t)
	s.SetLiked(track("b"), true)
	s.CreatePlaylist("p", []model.Track{track("a")})
	s.RecordPlay(track("b"))
	got := s.LibraryTracks()
	if len(got) != 2 {
		t.Fatalf("expected 2 unique tracks, got %v", ids(got))
	}
}

func TestSessionRoundTrip(t *testing.T) {
	s, dir := newStore(t)
	s.SaveSession(model.Session{Queue: []model.Track{track("a")}, Index: 0, Position: 12.5, Repeat: "all"})
	s.Close()
	reopened, _ := Open(dir)
	defer reopened.Close()
	sess := reopened.State().Session
	if sess == nil || sess.Position != 12.5 || sess.Repeat != "all" {
		t.Fatalf("session not restored: %+v", sess)
	}
	reopened.ClearSession()
	if reopened.State().Session != nil {
		t.Fatal("session not cleared")
	}
}

func ids(list []model.Track) []string {
	out := make([]string, len(list))
	for i, t := range list {
		out[i] = t.ID
	}
	return out
}
