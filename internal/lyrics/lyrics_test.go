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
