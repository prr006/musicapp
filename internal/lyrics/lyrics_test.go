package lyrics

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseLRC(t *testing.T) {
	raw := "[ar:Band]\n[offset:-500]\n[00:12.30]First line\n[00:15.5]Second\n[01:00]Third\n" +
		"[01:10.123][01:20.456]Repeated hook\nnot a timed line\n[bad]\n[02:00.00]\n"
	lines, offset := ParseLRC(raw)
	if math.Abs(offset-(-0.5)) > 1e-9 {
		t.Fatalf("offset: %v", offset)
	}
	want := []Line{
		{12.3, "First line"}, {15.5, "Second"}, {60, "Third"},
		{70.123, "Repeated hook"}, {80.456, "Repeated hook"}, {120, ""},
	}
	if len(lines) != len(want) {
		t.Fatalf("expected %d lines, got %d: %+v", len(want), len(lines), lines)
	}
	for i, w := range want {
		if math.Abs(lines[i].Time-w.Time) > 1e-6 || lines[i].Text != w.Text {
			t.Fatalf("line %d = %+v, want %+v", i, lines[i], w)
		}
	}
}

func TestParseLRCEmptyAndGarbage(t *testing.T) {
	if lines, _ := ParseLRC(""); len(lines) != 0 {
		t.Fatal("expected no lines")
	}
	if lines, _ := ParseLRC("just some plain lyrics\nwith no timings"); len(lines) != 0 {
		t.Fatal("plain text must not produce synthetic timings")
	}
}

func TestCleanTitleAndArtist(t *testing.T) {
	cases := map[string]string{
		"Nightfall (Official Video)":        "Nightfall",
		"Nightfall [Official Music Video] ": "Nightfall",
		"Nightfall - Official Audio":        "Nightfall",
		"Nightfall (feat. Someone)":         "Nightfall",
		"Nightfall (Remastered 2011)":       "Nightfall",
		"Plain Title":                       "Plain Title",
	}
	for in, want := range cases {
		if got := CleanTitle(in); got != want {
			t.Errorf("CleanTitle(%q) = %q, want %q", in, got, want)
		}
	}
	artists := map[string]string{
		"Halcyon - Topic":     "Halcyon",
		"HalcyonVEVO":         "Halcyon",
		"Halcyon & Friends":   "Halcyon",
		"Halcyon, Other":      "Halcyon",
		"Halcyon feat. Other": "Halcyon",
	}
	for in, want := range artists {
		if got := CleanArtist(in); got != want {
			t.Errorf("CleanArtist(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCleanTitleExtendedNoise(t *testing.T) {
	cases := map[string]string{
		"Believer (Official Video)":       "Believer",
		"Believer (Official Music Video)": "Believer",
		"Believer [Lyrics]":               "Believer",
		"Believer (Lyric Video)":          "Believer",
		"Believer (Official Audio)":       "Believer",
		"Believer (Visualizer)":           "Believer",
		"Believer (Live)":                 "Believer",
		"Believer (Live Performance)":     "Believer",
		"Believer (Remastered)":           "Believer",
		"Believer (Remaster)":             "Believer",
		"Believer (Remastered 2017)":      "Believer",
		"Believer (HD)":                   "Believer",
		"Believer (4K)":                   "Believer",
		"Believer (Cover)":                "Believer",
		"Believer (Acoustic)":             "Believer",
		"Believer (Slowed)":               "Believer",
		"Believer (Slowed + Reverb)":      "Believer",
		"Believer (Reverb)":               "Believer",
		"Believer (Sped Up)":              "Believer",
		"Believer (Nightcore)":            "Believer",
		"Believer - Official Video":       "Believer",
		"Believer - Lyrics":               "Believer",
		"Believer (Explicit)":             "Believer",
	}
	for in, want := range cases {
		if got := CleanTitle(in); got != want {
			t.Errorf("CleanTitle(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCleanTitleKeepsMeaningfulWords(t *testing.T) {
	cases := []string{
		"Live Forever",
		"Cover Me",
		"Acoustic",
		"Nightcore",
		"Reverb",
		"Sped Up",
		"Under the Cover of Darkness",
	}
	for _, in := range cases {
		if got := CleanTitle(in); got != in {
			t.Errorf("CleanTitle(%q) = %q, want unchanged %q", in, got, in)
		}
	}
}

func TestCleanArtistExtended(t *testing.T) {
	cases := map[string]string{
		"Halcyon featuring Other": "Halcyon",
		"Halcyon feat Other":      "Halcyon",
		"Halcyon ft. Other":       "Halcyon",
		"Halcyon ft Other":        "Halcyon",
	}
	for in, want := range cases {
		if got := CleanArtist(in); got != want {
			t.Errorf("CleanArtist(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestConfidenceLadder(t *testing.T) {
	q := Query{Title: "Believer", Artist: "Imagine Dragons"}
	exact := apiRecord{TrackName: "Believer", ArtistName: "Imagine Dragons", SyncedLyrics: "[00:01.00]x"}
	feat := apiRecord{TrackName: "Believer", ArtistName: "Imagine Dragons, JID", SyncedLyrics: "[00:01.00]x"}
	otherArtist := apiRecord{TrackName: "Believer", ArtistName: "Some Cover Band", SyncedLyrics: "[00:01.00]x"}
	wrongTitle := apiRecord{TrackName: "Believers", ArtistName: "Imagine Dragons", SyncedLyrics: "[00:01.00]x"}

	if got := Confidence(exact, q); got != ConfTitleArtist {
		t.Errorf("exact match confidence = %v, want ConfTitleArtist", got)
	}
	if got := Confidence(feat, q); got != ConfTitleArtist {
		t.Errorf("primary-artist match confidence = %v, want ConfTitleArtist", got)
	}
	if got := Confidence(otherArtist, q); got != ConfTitleOnly {
		t.Errorf("distinctive title-only confidence = %v, want ConfTitleOnly", got)
	}
	if got := Confidence(wrongTitle, q); got != ConfNone {
		t.Errorf("partial title match confidence = %v, want ConfNone", got)
	}

	// A short one-word title is too ambiguous for a title-only match.
	short := Query{Title: "Hello", Artist: "Adele"}
	otherHello := apiRecord{TrackName: "Hello", ArtistName: "Lionel Richie", SyncedLyrics: "[00:01.00]x"}
	if got := Confidence(otherHello, short); got != ConfNone {
		t.Errorf("ambiguous title-only confidence = %v, want ConfNone", got)
	}
}

func TestSelectPriorityAndAmbiguity(t *testing.T) {
	q := Query{Title: "Believer", Artist: "Imagine Dragons", Duration: 204}
	artistMatch := apiRecord{TrackName: "Believer", ArtistName: "Imagine Dragons", Duration: 206, SyncedLyrics: "[00:01.00]x"}
	otherArtist := apiRecord{TrackName: "Believer", ArtistName: "Nightcore Army", Duration: 203, SyncedLyrics: "[00:01.00]x"}
	otherArtist2 := apiRecord{TrackName: "Believer", ArtistName: "Cover Band", Duration: 205, SyncedLyrics: "[00:01.00]x"}
	unrelated := apiRecord{TrackName: "Thunder", ArtistName: "Imagine Dragons", SyncedLyrics: "[00:01.00]x"}

	// title + artist wins over title-only.
	if got := Select([]apiRecord{otherArtist, artistMatch}, q); got == nil || got.ArtistName != "Imagine Dragons" {
		t.Fatalf("expected the artist match to win, got %+v", got)
	}
	// a single non-matching artist is allowed when the title is distinctive.
	if got := Select([]apiRecord{otherArtist}, q); got == nil {
		t.Fatal("expected title-only fallback for a single distinctive title")
	}
	// the same title under two different artists is too ambiguous.
	if got := Select([]apiRecord{otherArtist, otherArtist2}, q); got != nil {
		t.Fatalf("expected ambiguity to reject the match, got %+v", got)
	}
	// an unrelated title never matches.
	if got := Select([]apiRecord{unrelated}, q); got != nil {
		t.Fatalf("expected unrelated title to be rejected, got %+v", got)
	}
}

func TestPickBestPrefersSyncedAndCloseDuration(t *testing.T) {
	recs := []apiRecord{
		{TrackName: "far", Duration: 400, SyncedLyrics: "[00:01.00]x"},
		{TrackName: "plain", Duration: 201, PlainLyrics: "words"},
		{TrackName: "synced", Duration: 203, SyncedLyrics: "[00:01.00]x"},
	}
	best := PickBest(recs, 200)
	if best == nil || best.TrackName != "synced" {
		t.Fatalf("unexpected pick: %+v", best)
	}
	if PickBest(recs[:1], 200) != nil {
		t.Fatal("records outside the duration window must be rejected")
	}
	if PickBest(nil, 0) != nil {
		t.Fatal("expected nil for no records")
	}
}

func testClient(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c := New()
	c.BaseURL = srv.URL
	return c
}

func TestFetchSyncedViaGet(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/get" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.URL.Query().Get("duration") != "210" {
			t.Errorf("duration not sent: %s", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(apiRecord{
			TrackName: "Nightfall", ArtistName: "Halcyon", Duration: 210,
			SyncedLyrics: "[00:10.00]one\n[00:20.00]two",
		})
	})
	res, err := c.Fetch(context.Background(), Query{
		TrackID: "yt:1", Title: "Nightfall (Official Video)", Artist: "Halcyon - Topic", Duration: 210,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Synced || len(res.Lines) != 2 || res.Lines[1].Time != 20 {
		t.Fatalf("bad result: %+v", res)
	}
	if res.TrackID != "yt:1" {
		t.Fatalf("result must carry the track id for stale-guarding: %+v", res)
	}
}

func TestFetchFallsBackToSearchAndPlain(t *testing.T) {
	var searched bool
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/get" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		searched = true
		_ = json.NewEncoder(w).Encode([]apiRecord{
			{TrackName: "Nightfall", Duration: 212, PlainLyrics: "just words"},
		})
	})
	res, err := c.Fetch(context.Background(), Query{TrackID: "yt:2", Title: "Nightfall", Artist: "Halcyon", Duration: 210})
	if err != nil {
		t.Fatal(err)
	}
	if !searched {
		t.Fatal("expected search fallback")
	}
	if res.Synced || res.Plain != "just words" {
		t.Fatalf("expected plain fallback: %+v", res)
	}
}

func TestFetchNotFound(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/get" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`[]`))
	})
	_, err := c.Fetch(context.Background(), Query{TrackID: "yt:3", Title: "Unknown", Artist: "Nobody"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestFetchMalformedPayload(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"trackName": [broken`))
	})
	_, err := c.Fetch(context.Background(), Query{TrackID: "yt:4", Title: "T", Artist: "A"})
	if !errors.Is(err, ErrProvider) {
		t.Fatalf("expected ErrProvider, got %v", err)
	}
}

func TestFetchProviderDown(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	_, err := c.Fetch(context.Background(), Query{TrackID: "yt:5", Title: "T", Artist: "A"})
	if !errors.Is(err, ErrProvider) {
		t.Fatalf("expected ErrProvider, got %v", err)
	}
}

func TestFetchNetworkFailure(t *testing.T) {
	c := New()
	c.BaseURL = "http://127.0.0.1:1"
	_, err := c.Fetch(context.Background(), Query{TrackID: "yt:6", Title: "T", Artist: "A"})
	if !errors.Is(err, ErrNetwork) {
		t.Fatalf("expected ErrNetwork, got %v", err)
	}
}

func TestFetchCaches(t *testing.T) {
	var hits int
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		hits++
		_ = json.NewEncoder(w).Encode(apiRecord{TrackName: "T", SyncedLyrics: "[00:01.00]a"})
	})
	q := Query{TrackID: "yt:7", Title: "T", Artist: "A"}
	if _, err := c.Fetch(context.Background(), q); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Fetch(context.Background(), q); err != nil {
		t.Fatal(err)
	}
	if hits != 1 {
		t.Fatalf("expected caching, got %d requests", hits)
	}
}

func TestFetchRejectsUnrelatedGetMatch(t *testing.T) {
	var searched bool
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/get" {
			// LRCLIB's get endpoint fuzzy-matched a different song entirely.
			_ = json.NewEncoder(w).Encode(apiRecord{
				TrackName: "Some Other Song", ArtistName: "Halcyon", Duration: 210,
				SyncedLyrics: "[00:10.00]wrong",
			})
			return
		}
		searched = true
		_ = json.NewEncoder(w).Encode([]apiRecord{
			{TrackName: "Nightfall", ArtistName: "Halcyon", Duration: 211, SyncedLyrics: "[00:10.00]right"},
		})
	})
	res, err := c.Fetch(context.Background(), Query{
		TrackID: "yt:9", Title: "Nightfall", Artist: "Halcyon", Duration: 210,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !searched {
		t.Fatal("expected search fallback after rejecting an unrelated get match")
	}
	if res.MatchedTitle != "Nightfall" || len(res.Lines) == 0 || res.Lines[0].Text != "right" {
		t.Fatalf("expected the correct track's lyrics, got %+v", res)
	}
}

func TestFetchNoMatchForUnrelatedSong(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/get" {
			_ = json.NewEncoder(w).Encode(apiRecord{TrackName: "Other", ArtistName: "X", SyncedLyrics: "[00:01.00]x"})
			return
		}
		_, _ = w.Write([]byte(`[{"trackName":"Other","artistName":"X","syncedLyrics":"[00:01.00]x"}]`))
	})
	_, err := c.Fetch(context.Background(), Query{TrackID: "yt:10", Title: "Nightfall", Artist: "Halcyon"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for an unrelated song, got %v", err)
	}
}

func TestInstrumentalIsNotAnError(t *testing.T) {
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(apiRecord{TrackName: "T", Instrumental: true})
	})
	res, err := c.Fetch(context.Background(), Query{TrackID: "yt:8", Title: "T", Artist: "A"})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Instrumental {
		t.Fatalf("expected instrumental flag: %+v", res)
	}
}
