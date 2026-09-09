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
	if len(res.Videos) != 1 || res.Videos[0].Artist != "Halcyon Official" {
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

func TestSearchSurfacesNetworkError(t *testing.T) {
	c := New()
	c.Endpoint = "http://127.0.0.1:1/none"
	if _, err := c.Search(context.Background(), "x", ""); err == nil {
		t.Fatal("expected a network error to surface")
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
	c := New()
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
	c := New()
	res, err := c.Search(context.Background(), "   ", "")
	if err != nil || len(res.Songs) != 0 {
		t.Fatalf("expected empty response, got %+v %v", res, err)
	}
}
