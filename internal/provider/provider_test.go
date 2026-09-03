package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// innerTubeFixture mirrors the shape of a YouTube Music search payload: a
// shelf of musicResponsiveListItemRenderer entries (song, video, album, artist).
const innerTubeFixture = `{
 "contents": {"tabbedSearchResultsRenderer": {"tabs": [{"tabRenderer": {"content": {"sectionListRenderer": {"contents": [
  {"musicShelfRenderer": {"contents": [
   {"musicResponsiveListItemRenderer": {
     "thumbnail": {"musicThumbnailRenderer": {"thumbnail": {"thumbnails": [
       {"url": "https://lh3.googleusercontent.com/abc=w60-h60-l90-rj", "width": 60, "height": 60},
       {"url": "https://lh3.googleusercontent.com/abc=w120-h120-l90-rj", "width": 120, "height": 120}
     ]}}},
     "flexColumns": [
      {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Nightfall"}]}}},
      {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [
        {"text": "Song"}, {"text": " • "},
        {"text": "Halcyon", "navigationEndpoint": {"browseEndpoint": {"browseId": "UC12345"}}},
        {"text": " • "},
        {"text": "Blue Hours", "navigationEndpoint": {"browseEndpoint": {"browseId": "MPREb_9999"}}},
        {"text": " • "}, {"text": "3:42"}
      ]}}}
     ],
     "badges": [{"musicInlineBadgeRenderer": {"icon": {"iconType": "MUSIC_EXPLICIT_BADGE"}}}],
     "overlay": {"musicItemThumbnailOverlayRenderer": {"content": {"musicPlayButtonRenderer": {
       "playNavigationEndpoint": {"watchEndpoint": {"videoId": "aaaaaaaaaaa"}}}}}}
   }},
   {"musicResponsiveListItemRenderer": {
     "flexColumns": [
      {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Live at Dusk"}]}}},
      {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [
        {"text": "Video"}, {"text": " • "}, {"text": "Halcyon Official"}, {"text": " • "}, {"text": "1:02:05"}
      ]}}}
     ],
     "overlay": {"musicItemThumbnailOverlayRenderer": {"content": {"musicPlayButtonRenderer": {
       "playNavigationEndpoint": {"watchEndpoint": {"videoId": "bbbbbbbbbbb"}}}}}}
   }},
   {"musicResponsiveListItemRenderer": {
     "navigationEndpoint": {"browseEndpoint": {"browseId": "MPREb_album1"}},
     "flexColumns": [
      {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Blue Hours"}]}}},
      {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [
        {"text": "Album"}, {"text": " • "}, {"text": "Halcyon"}, {"text": " • "}, {"text": "2021"}
      ]}}}
     ]
   }},
   {"musicResponsiveListItemRenderer": {
     "navigationEndpoint": {"browseEndpoint": {"browseId": "UC12345"}},
     "flexColumns": [
      {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Halcyon"}]}}},
      {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Artist"}]}}}
     ]
   }}
  ]}}
 ]}}}}]}}
}`

func TestParseSearchResponse(t *testing.T) {
	res, err := ParseSearchResponse([]byte(innerTubeFixture))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(res.Songs) != 1 {
		t.Fatalf("expected 1 song, got %d", len(res.Songs))
	}
	s := res.Songs[0]
	if s.ID != "yt:aaaaaaaaaaa" || s.SourceID != "aaaaaaaaaaa" {
		t.Fatalf("bad ids: %+v", s)
	}
	if s.Title != "Nightfall" || s.Artist != "Halcyon" || s.Album != "Blue Hours" {
		t.Fatalf("bad metadata: %+v", s)
	}
	if s.Duration != 222 {
		t.Fatalf("expected 222s, got %v", s.Duration)
	}
	if !s.Explicit {
		t.Fatal("expected explicit badge")
	}
	if !strings.Contains(s.Artwork, "w544-h544") {
		t.Fatalf("expected upgraded real artwork url, got %q", s.Artwork)
	}
	if len(res.Videos) != 1 || res.Videos[0].Artist != "" || res.Videos[0].Uploader != "Halcyon Official" {
		// A bare channel name is uploader metadata, never the performing artist.
		t.Fatalf("bad video result: %+v", res.Videos)
	}
	if res.Videos[0].Duration != 3725 {
		t.Fatalf("expected h:mm:ss parsing, got %v", res.Videos[0].Duration)
	}
	if len(res.Albums) != 1 || res.Albums[0].Title != "Blue Hours" || res.Albums[0].Year != "2021" {
		t.Fatalf("bad album: %+v", res.Albums)
	}
	if len(res.Artists) != 1 || res.Artists[0].Name != "Halcyon" {
		t.Fatalf("bad artist: %+v", res.Artists)
	}
}

func TestParseSearchResponseEmptyAndMalformed(t *testing.T) {
	res, err := ParseSearchResponse([]byte(`{"contents":{}}`))
	if err != nil {
		t.Fatalf("empty payload should not error: %v", err)
	}
	if len(res.Songs) != 0 {
		t.Fatal("expected no songs")
	}
	if _, err := ParseSearchResponse([]byte(`not json`)); err == nil {
		t.Fatal("expected error for malformed payload")
	}
}

func TestMissingArtworkStaysEmpty(t *testing.T) {
	res, err := ParseSearchResponse([]byte(`{"c":{"musicResponsiveListItemRenderer":{
	  "flexColumns":[{"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"No Art"}]}}}],
	  "overlay":{"x":{"watchEndpoint":{"videoId":"ccccccccccc"}}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Songs) != 1 || res.Songs[0].Artwork != "" {
		t.Fatalf("expected empty artwork rather than a fake placeholder: %+v", res.Songs)
	}
}

type fakeRunner struct {
	out []byte
	err error
	got []string
}

func (f *fakeRunner) Run(_ context.Context, args ...string) ([]byte, error) {
	f.got = args
	return f.out, f.err
}

func TestParseYTDLPSearch(t *testing.T) {
	payload := map[string]any{"entries": []map[string]any{{
		"id": "xyz", "title": "Track One", "uploader": "Chan", "duration": 200.0,
		"thumbnails": []map[string]any{{"url": "http://img/1.jpg", "width": 100}},
	}, {"id": "", "title": "skip"}}}
	raw, _ := json.Marshal(payload)
	res, err := ParseYTDLPSearch(raw, "q")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Songs) != 1 || res.Songs[0].ID != "yt:xyz" || res.Songs[0].Artist != "" || res.Songs[0].Uploader != "Chan" {
		// Uploader/channel is metadata, not the performing artist.
		t.Fatalf("bad parse: %+v", res.Songs)
	}
	if res.Provider != "yt-dlp" {
		t.Fatalf("provider should be tagged: %q", res.Provider)
	}
}

func TestSearchFallsBackToYTDLP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	raw, _ := json.Marshal(map[string]any{"entries": []map[string]any{
		{"id": "fallback1", "title": "Fallback", "uploader": "Chan", "duration": 100.0},
	}})
	runner := &fakeRunner{out: raw}
	c := New(runner)
	c.Endpoint = srv.URL

	res, err := c.Search(context.Background(), "anything", "")
	if err != nil {
		t.Fatalf("expected fallback to succeed: %v", err)
	}
	if res.Provider != "yt-dlp" || len(res.Songs) != 1 || res.Songs[0].SourceID != "fallback1" {
		t.Fatalf("unexpected fallback result: %+v", res)
	}
}

func TestSearchSurfacesNetworkError(t *testing.T) {
	c := New(&fakeRunner{err: context.DeadlineExceeded})
	c.Endpoint = "http://127.0.0.1:1/none"
	if _, err := c.Search(context.Background(), "x", ""); err == nil {
		t.Fatal("expected an error when both provider and fallback fail")
	}
}

func TestSearchInnerTubeSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["query"] != "nightfall" {
			t.Errorf("query not forwarded: %+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(innerTubeFixture))
	}))
	defer srv.Close()
	c := New(&fakeRunner{})
	c.Endpoint = srv.URL
	res, err := c.Search(context.Background(), "nightfall", "songs")
	if err != nil {
		t.Fatal(err)
	}
	if res.Provider != "ytmusic" || len(res.Songs) != 1 {
		t.Fatalf("unexpected: %+v", res)
	}
}

func TestEmptyQueryShortCircuits(t *testing.T) {
	c := New(&fakeRunner{})
	res, err := c.Search(context.Background(), "   ", "")
	if err != nil || len(res.Songs) != 0 {
		t.Fatalf("expected empty response, got %+v %v", res, err)
	}
}

// nextFixture mirrors the YouTube Music /next watch payload: a queue panel of
// playlistPanelVideoRenderer items ("Up next"), including the seed echo.
const nextFixture = `{
 "contents": {"singleColumnMusicWatchNextResultsRenderer": {"playlist": {"playlist": {"contents": [
  {"playlistPanelVideoRenderer": {
    "videoId": "seed111",
    "title": {"runs": [{"text": "Nightfall"}]},
    "longBylineText": {"runs": [{"text": "Halcyon"}]},
    "lengthText": {"runs": [{"text": "3:42"}]}
  }},
  {"playlistPanelVideoRenderer": {
    "videoId": "rel222",
    "title": {"runs": [{"text": "Paper Lanterns"}]},
    "longBylineText": {"runs": [
      {"text": "Halcyon", "navigationEndpoint": {"browseEndpoint": {"browseId": "UC12345"}}},
      {"text": " • "},
      {"text": "Blue Hours", "navigationEndpoint": {"browseEndpoint": {"browseId": "MPREb_9999"}}},
      {"text": " • "},
      {"text": "2:35"}
    ]},
    "lengthText": {"runs": [{"text": "2:35"}]},
    "thumbnail": {"thumbnails": [{"url": "https://i.ytimg.com/vi/rel222/mqdefault.jpg", "width": 320}]}
  }},
  {"playlistPanelVideoRenderer": {
    "videoId": "rel333",
    "title": {"runs": [{"text": "Live at Dusk"}]},
    "shortBylineText": {"runs": [
      {"text": "Halcyon - Topic"},
      {"text": " • "},
      {"text": "1:02:05"}
    ]},
    "lengthText": {"runs": [{"text": "1:02:05"}]}
  }}
 ]}}}}
}`

func TestParseNextResponse(t *testing.T) {
	res, err := ParseNextResponse([]byte(nextFixture))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if res.Source != "ytmusic-next" {
		t.Fatalf("expected ytmusic-next source tag, got %q", res.Source)
	}
	if len(res.Tracks) != 3 {
		t.Fatalf("expected 3 panel tracks, got %d", len(res.Tracks))
	}
	second := res.Tracks[1]
	if second.ID != "yt:rel222" || second.Title != "Paper Lanterns" {
		t.Fatalf("bad identity: %+v", second)
	}
	if second.Artist != "Halcyon" || second.Album != "Blue Hours" {
		t.Fatalf("bad metadata: %+v", second)
	}
	if second.Duration != 155 {
		t.Fatalf("expected 155s, got %v", second.Duration)
	}
	if !strings.Contains(second.Artwork, "mqdefault") {
		t.Fatalf("expected real artwork, got %q", second.Artwork)
	}
	third := res.Tracks[2]
	if third.Artist != "Halcyon" || third.Uploader != "Halcyon - Topic" || third.Duration != 3725 {
		// "- Topic" channels are official artist channels: promoted to artist,
		// with the raw channel preserved as uploader metadata.
		t.Fatalf("expected topic-channel promotion: %+v", third)
	}
}

func TestRelatedInnerTubeSuccessAndSeedEcho(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["videoId"] != "seed111" {
			t.Errorf("video id not forwarded: %+v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(nextFixture))
	}))
	defer srv.Close()
	c := New(&fakeRunner{})
	c.NextEndpoint = srv.URL
	res, err := c.Related(context.Background(), "seed111")
	if err != nil {
		t.Fatal(err)
	}
	if res.Source != "ytmusic-next" || len(res.Tracks) != 3 {
		t.Fatalf("unexpected radio response: %+v", res)
	}
}

func TestRelatedFallsBackToMixPlaylist(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	raw, _ := json.Marshal(map[string]any{"entries": []map[string]any{
		{"id": "mix1", "title": "Mix Track", "uploader": "Other Artist", "duration": 180.0},
		{"id": "mix2", "title": "Mix Track Two", "uploader": "Someone", "duration": 200.0},
	}})
	runner := &fakeRunner{out: raw}
	c := New(runner)
	c.NextEndpoint = srv.URL

	res, err := c.Related(context.Background(), "seed111")
	if err != nil {
		t.Fatalf("expected mix fallback to succeed: %v", err)
	}
	if res.Source != "yt-dlp-mix" || len(res.Tracks) != 2 {
		t.Fatalf("unexpected mix response: %+v", res)
	}
	if res.Tracks[0].SourceID != "mix1" {
		t.Fatalf("bad mix track: %+v", res.Tracks[0])
	}
	wantList := "https://www.youtube.com/playlist?list=RDseed111"
	found := false
	for _, arg := range runner.got {
		if arg == wantList {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected the seed mix playlist %q, got %v", wantList, runner.got)
	}
}

func TestRelatedErrorsWhenAllSourcesFail(t *testing.T) {
	c := New(&fakeRunner{err: context.DeadlineExceeded})
	c.NextEndpoint = "http://127.0.0.1:1/none"
	if _, err := c.Related(context.Background(), "seed111"); err == nil {
		t.Fatal("expected an error when both radio sources fail")
	}
}

func TestArtistFromChannel(t *testing.T) {
	// The one channel shape that explicitly identifies an artist.
	if artist, ok := artistFromChannel("Homixide Gang - Topic"); !ok || artist != "Homixide Gang" {
		t.Fatalf("topic channel should promote its artist: %q %v", artist, ok)
	}
	// Everything else stays uploader metadata — including "fearless", the
	// channel behind "Farben (Slowed)" that used to become a bogus artist.
	for _, channel := range []string{"fearless", "Halcyon Official", "TaylorSwiftVEVO", "Music Channel"} {
		if _, ok := artistFromChannel(channel); ok {
			t.Fatalf("channel %q must not be treated as an artist", channel)
		}
	}
}

// automixFixture: the first /next answer for most uploads — no queue items,
// only an autoplay preview holding the continuation token.
const automixFixture = `{
 "contents": {"singleColumnMusicWatchNextResultsRenderer": {"playlist": {"playlist": {"contents": [
  {"automixPreviewVideoRenderer": {"content": {"automixPlaylistVideoRenderer": {
    "mixId": "RDxyz",
    "CONTINUATION": {"continuationCommand": {"token": "automix-token-123"}}
  }}}}
 ]}}}}
}`

// automixContinuationFixture: the answer to the continuation request — the
// real autoplay queue under continuationContents.
const automixContinuationFixture = `{
 "continuationContents": {"playlistPanelContinuation": {"contents": [
  {"playlistPanelVideoRenderer": {
    "videoId": "mix-a",
    "title": {"runs": [{"text": "Nuvole Bianche"}]},
    "longBylineText": {"runs": [
      {"text": "Einaudi", "navigationEndpoint": {"browseEndpoint": {"browseId": "UCEinaudi"}}},
      {"text": " • "},
      {"text": "2:59"}
    ]},
    "lengthText": {"runs": [{"text": "2:59"}]}
  }},
  {"playlistPanelVideoRenderer": {
    "videoId": "mix-b",
    "title": {"runs": [{"text": "Farben (Slowed)"}]},
    "shortBylineText": {"runs": [{"text": "fearless"}, {"text": " • "}, {"text": "3:12"}]},
    "lengthText": {"runs": [{"text": "3:12"}]}
  }}
 ]}}
}`

func TestRelatedFollowsAutomixContinuation(t *testing.T) {
	var calls []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		calls = append(calls, body)
		w.Header().Set("Content-Type", "application/json")
		if body["videoId"] != nil {
			_, _ = w.Write([]byte(automixFixture))
			return
		}
		_, _ = w.Write([]byte(automixContinuationFixture))
	}))
	defer srv.Close()
	c := New(&fakeRunner{})
	c.NextEndpoint = srv.URL

	res, err := c.Related(context.Background(), "seed111")
	if err != nil {
		t.Fatal(err)
	}
	if res.Source != "ytmusic-next" || len(res.Tracks) != 2 {
		t.Fatalf("expected the automix queue, got %+v", res)
	}
	if res.Tracks[0].Title != "Nuvole Bianche" || res.Tracks[0].Artist != "Einaudi" {
		t.Fatalf("bad mix track: %+v", res.Tracks[0])
	}
	// The channel behind a slowed upload stays uploader metadata, never artist.
	if res.Tracks[1].Artist != "" || res.Tracks[1].Uploader != "fearless" {
		t.Fatalf("uploader must not leak into artist: %+v", res.Tracks[1])
	}
	if len(calls) != 2 || calls[1]["continuation"] != "automix-token-123" {
		t.Fatalf("the autoplay continuation must be requested: %+v", calls)
	}
}
