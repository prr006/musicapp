package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"melo/internal/model"
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
	if res.Source != "ytmusic-next" || len(res.Tracks) != 2 {
		t.Fatalf("unexpected radio response: %+v", res)
	}
	// The seed echo is stripped by the provider itself: a self-echo is never
	// a usable recommendation candidate.
	for _, tr := range res.Tracks {
		if tr.SourceID == "seed111" {
			t.Fatalf("seed echo must not be delivered: %+v", tr)
		}
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

// watchAllSurfacesFixture mirrors a watch-next page for a non-catalog upload
// (the "LUZ ROJA (Slowed)" shape): an artist-dominated queue panel PLUS a
// regular-YouTube related feed (compactVideoRenderer), music shelves
// (musicResponsiveListItemRenderer, including a non-video album row) and a
// video tile (musicTwoRowItemRenderer).
const watchAllSurfacesFixture = `{
 "contents": {
  "singleColumnMusicWatchNextResultsRenderer": {
   "playlist": {
    "playlist": {
     "contents": [
      {
       "playlistPanelVideoRenderer": {
        "videoId": "f1",
        "title": {
         "runs": [
          {
           "text": "FUNK CRIMINAL"
          }
         ]
        },
        "longBylineText": {
         "runs": [
          {
           "text": "bxkq",
           "navigationEndpoint": {
            "browseEndpoint": {
             "browseId": "UCbxkq"
            }
           }
          },
          {
           "text": " \u2022 "
          },
          {
           "text": "3:12"
          }
         ]
        },
        "lengthText": {
         "runs": [
          {
           "text": "3:12"
          }
         ]
        }
       }
      },
      {
       "playlistPanelVideoRenderer": {
        "videoId": "f2",
        "title": {
         "runs": [
          {
           "text": "FUNK TAKA"
          }
         ]
        },
        "longBylineText": {
         "runs": [
          {
           "text": "bxkq",
           "navigationEndpoint": {
            "browseEndpoint": {
             "browseId": "UCbxkq"
            }
           }
          },
          {
           "text": " \u2022 "
          },
          {
           "text": "2:48"
          }
         ]
        },
        "lengthText": {
         "runs": [
          {
           "text": "2:48"
          }
         ]
        }
       }
      },
      {
       "playlistPanelVideoRenderer": {
        "videoId": "f3",
        "title": {
         "runs": [
          {
           "text": "FUNK UNICO"
          }
         ]
        },
        "longBylineText": {
         "runs": [
          {
           "text": "bxkq",
           "navigationEndpoint": {
            "browseEndpoint": {
             "browseId": "UCbxkq"
            }
           }
          },
          {
           "text": " \u2022 "
          },
          {
           "text": "3:01"
          }
         ]
        },
        "lengthText": {
         "runs": [
          {
           "text": "3:01"
          }
         ]
        }
       }
      },
      {
       "playlistPanelVideoRenderer": {
        "videoId": "f4",
        "title": {
         "runs": [
          {
           "text": "FUNK SERENO"
          }
         ]
        },
        "longBylineText": {
         "runs": [
          {
           "text": "bxkq",
           "navigationEndpoint": {
            "browseEndpoint": {
             "browseId": "UCbxkq"
            }
           }
          },
          {
           "text": " \u2022 "
          },
          {
           "text": "2:59"
          }
         ]
        },
        "lengthText": {
         "runs": [
          {
           "text": "2:59"
          }
         ]
        }
       }
      },
      {
       "playlistPanelVideoRenderer": {
        "videoId": "f5",
        "title": {
         "runs": [
          {
           "text": "FUNK MADA"
          }
         ]
        },
        "longBylineText": {
         "runs": [
          {
           "text": "bxkq",
           "navigationEndpoint": {
            "browseEndpoint": {
             "browseId": "UCbxkq"
            }
           }
          },
          {
           "text": " \u2022 "
          },
          {
           "text": "3:33"
          }
         ]
        },
        "lengthText": {
         "runs": [
          {
           "text": "3:33"
          }
         ]
        }
       }
      },
      {
       "playlistPanelVideoRenderer": {
        "videoId": "f6",
        "title": {
         "runs": [
          {
           "text": "OTRO FUNK"
          }
         ]
        },
        "longBylineText": {
         "runs": [
          {
           "text": "bxkq",
           "navigationEndpoint": {
            "browseEndpoint": {
             "browseId": "UCbxkq"
            }
           }
          },
          {
           "text": " \u2022 "
          },
          {
           "text": "2:44"
          }
         ]
        },
        "lengthText": {
         "runs": [
          {
           "text": "2:44"
          }
         ]
        }
       }
      }
     ]
    }
   },
   "secondaryResults": {
    "secondaryResults": {
     "results": [
      {
       "compactVideoRenderer": {
        "videoId": "r1",
        "title": {
         "runs": [
          {
           "text": "OTRA NOCHE (Phonk)"
          }
         ]
        },
        "longBylineText": {
         "runs": [
          {
           "text": "DYLAn - Topic"
          }
         ]
        },
        "lengthText": {
         "simpleText": "2:31"
        }
       }
      },
      {
       "compactVideoRenderer": {
        "videoId": "r2",
        "title": {
         "runs": [
          {
           "text": "mucho party (slowed)"
          }
         ]
        },
        "longBylineText": {
         "runs": [
          {
           "text": "Slowed Music Channel"
          }
         ]
        },
        "lengthText": {
         "simpleText": "3:05"
        }
       }
      },
      {
       "compactVideoRenderer": {
        "videoId": "f3",
        "title": {
         "runs": [
          {
           "text": "FUNK UNICO (dup surface)"
          }
         ]
        },
        "longBylineText": {
         "runs": [
          {
           "text": "bxkq"
          }
         ]
        },
        "lengthText": {
         "simpleText": "3:01"
        }
       }
      }
     ]
    }
   },
   "sectionListRenderer": {
    "contents": [
     {
      "musicShelfRenderer": {
       "title": {
        "runs": [
         {
          "text": "Related"
         }
        ]
       },
       "contents": [
        {
         "musicResponsiveListItemRenderer": {
          "flexColumns": [
           {
            "musicResponsiveListItemFlexColumnRenderer": {
             "text": {
              "runs": [
               {
                "text": "Velvet Static"
               }
              ]
             }
            }
           },
           {
            "musicResponsiveListItemFlexColumnRenderer": {
             "text": {
              "runs": [
               {
                "text": "Song"
               },
               {
                "text": " \u2022 "
               },
               {
                "text": "Nohidea",
                "navigationEndpoint": {
                 "browseEndpoint": {
                  "browseId": "UCnohidea"
                 }
                }
               },
               {
                "text": " \u2022 "
               },
               {
                "text": "Late Files",
                "navigationEndpoint": {
                 "browseEndpoint": {
                  "browseId": "MPREb_77"
                 }
                }
               },
               {
                "text": " \u2022 "
               },
               {
                "text": "4:02"
               }
              ]
             }
            }
           }
          ],
          "overlay": {
           "musicItemThumbnailOverlayRenderer": {
            "content": {
             "musicPlayButtonRenderer": {
              "playNavigationEndpoint": {
               "watchEndpoint": {
                "videoId": "s1"
               }
              }
             }
            }
           }
          }
         }
        },
        {
         "musicResponsiveListItemRenderer": {
          "flexColumns": [
           {
            "musicResponsiveListItemFlexColumnRenderer": {
             "text": {
              "runs": [
               {
                "text": "Basement Tapes"
               }
              ]
             }
            }
           },
           {
            "musicResponsiveListItemFlexColumnRenderer": {
             "text": {
              "runs": [
               {
                "text": "Song"
               },
               {
                "text": " \u2022 "
               },
               {
                "text": "Kupla",
                "navigationEndpoint": {
                 "browseEndpoint": {
                  "browseId": "UCkupla"
                 }
                }
               },
               {
                "text": " \u2022 "
               },
               {
                "text": "3:18"
               }
              ]
             }
            }
           }
          ],
          "overlay": {
           "musicItemThumbnailOverlayRenderer": {
            "content": {
             "musicPlayButtonRenderer": {
              "playNavigationEndpoint": {
               "watchEndpoint": {
                "videoId": "s2"
               }
              }
             }
            }
           }
          }
         }
        },
        {
         "musicResponsiveListItemRenderer": {
          "navigationEndpoint": {
           "browseEndpoint": {
            "browseId": "MPREb_album9"
           }
          },
          "flexColumns": [
           {
            "musicResponsiveListItemFlexColumnRenderer": {
             "text": {
              "runs": [
               {
                "text": "An Album"
               }
              ]
             }
            }
           },
           {
            "musicResponsiveListItemFlexColumnRenderer": {
             "text": {
              "runs": [
               {
                "text": "Album"
               }
              ]
             }
            }
           }
          ]
         }
        }
       ]
      }
     },
     {
      "musicCarouselShelfRenderer": {
       "contents": [
        {
         "musicTwoRowItemRenderer": {
          "navigationEndpoint": {
           "watchEndpoint": {
            "videoId": "t9"
           }
          },
          "title": {
           "runs": [
            {
             "text": "Rave Dongeon"
            }
           ]
          },
          "subtitle": {
           "runs": [
            {
             "text": "MYSSER"
            },
            {
             "text": " \u2022 "
            },
            {
             "text": "2.1M views"
            },
            {
             "text": " \u2022 "
            },
            {
             "text": "2:54"
            }
           ]
          }
         }
        }
       ]
      }
     }
    ]
   }
  }
 }
}`

func TestParseNextResponseCollectsAllSurfaces(t *testing.T) {
	res, err := ParseNextResponse([]byte(watchAllSurfacesFixture))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// 6 queue + 2 new related videos (the third duplicates f3) + 2 shelf
	// songs (the album row has no watch endpoint) + 1 tile.
	if len(res.Tracks) != 11 {
		t.Fatalf("expected 11 candidates across surfaces, got %d: %+v", len(res.Tracks), res.Tracks)
	}
	if res.Tracks[0].SourceID != "f1" || res.Tracks[5].SourceID != "f6" {
		t.Fatalf("queue panel must come first (provider order), got %s, %s", res.Tracks[0].SourceID, res.Tracks[5].SourceID)
	}
	byShelf := map[string]int{}
	for _, sh := range res.Shelves {
		byShelf[sh.Kind] = sh.Count
	}
	if byShelf["queue"] != 6 || byShelf["related-videos"] != 2 || byShelf["music-shelves"] != 2 || byShelf["tiles"] != 1 {
		t.Fatalf("bad shelf provenance: %+v", res.Shelves)
	}
	// A "- Topic" channel on a video surface is a real artist…
	var r1 model.Track
	for _, tr := range res.Tracks {
		if tr.SourceID == "r1" {
			r1 = tr
		}
	}
	if r1.Artist != "DYLAn" || r1.Uploader != "DYLAn - Topic" || r1.Duration != 151 {
		t.Fatalf("topic-channel promotion failed: %+v", r1)
	}
	// …but a bare uploading channel NEVER becomes the artist.
	var r2 model.Track
	for _, tr := range res.Tracks {
		if tr.SourceID == "r2" {
			r2 = tr
		}
	}
	if r2.Artist != "" || r2.Uploader != "Slowed Music Channel" {
		t.Fatalf("uploader must not leak into artist identity: %+v", r2)
	}
	// Shelf songs keep the music-surface identity rules.
	var s1 model.Track
	for _, tr := range res.Tracks {
		if tr.SourceID == "s1" {
			s1 = tr
		}
	}
	if s1.Artist != "Nohidea" || s1.Album != "Late Files" || s1.Duration != 242 {
		t.Fatalf("bad shelf item: %+v", s1)
	}
	if artistDominated(res.Tracks) {
		t.Fatalf("a mixed-surface feed must not read as artist-dominated")
	}
}

func TestParseNextResponseDetectsArtistDominatedQueue(t *testing.T) {
	if !artistDominated([]model.Track{
		{Artist: "bxkq"}, {Artist: "bxkq"}, {Artist: "bxkq"},
		{Artist: "bxkq"}, {Artist: "bxkq"}, {Artist: "bxkq, AAVARU"}, {Artist: "bxkq"},
	}) {
		t.Fatalf("6/7 one artist is dominated")
	}
	if artistDominated([]model.Track{
		{Artist: "bxkq"}, {Artist: "bxkq"}, {Artist: "DYLAn"},
		{Artist: "Nohidea"}, {Artist: "Kupla"}, {Artist: "MYSSER"}, {Artist: "PXLWVYSE"},
	}) {
		t.Fatalf("a genuinely mixed feed is not dominated")
	}
}

// The full ladder for a non-catalog seed whose videoId /next answer is empty:
// the RDAMVM song-radio playlist must be requested before giving up.
func TestRelatedInnerTubeFallsThroughToRadioPlaylist(t *testing.T) {
	var gotPlaylistID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if pid, _ := body["playlistId"].(string); pid != "" {
			gotPlaylistID = pid
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(nextFixture))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"contents": {}}`))
	}))
	defer srv.Close()
	c := New(&fakeRunner{})
	c.NextEndpoint = srv.URL
	res, err := c.Related(context.Background(), "seed111")
	if err != nil {
		t.Fatal(err)
	}
	if gotPlaylistID != "RDAMVMseed111" {
		t.Fatalf("expected the RDAMVM song-radio request, got %q", gotPlaylistID)
	}
	if len(res.Tracks) != 2 {
		t.Fatalf("expected the radio playlist's 2 usable tracks (seed echo stripped), got %d", len(res.Tracks))
	}
	if !shelfCounts(res, "radio", 2) {
		t.Fatalf("radio stage must be recorded in provenance: %+v", res.Shelves)
	}
}

// An artist-dominated queue is not accepted as the radio: the RDAMVM playlist
// is fetched as a genuinely broader source and merged behind the queue.
func TestRelatedMergesRadioWhenQueueArtistDominated(t *testing.T) {
	// Eight queue rows, all bxkq: the artist-dominated shape.
	items := make([]map[string]any, 8)
	for i := range items {
		items[i] = map[string]any{"playlistPanelVideoRenderer": map[string]any{
			"videoId": fmt.Sprintf("g%d", i),
			"title":   map[string]any{"runs": []map[string]any{{"text": "FUNK"}}},
			"longBylineText": map[string]any{"runs": []map[string]any{
				{"text": "bxkq", "navigationEndpoint": map[string]any{
					"browseEndpoint": map[string]any{"browseId": "UCbxkq"}}}}},
		}}
	}
	dominatedRaw, _ := json.Marshal(map[string]any{
		"contents": map[string]any{"singleColumnMusicWatchNextResultsRenderer": map[string]any{
			"playlist": map[string]any{"playlist": map[string]any{"contents": items}}}},
	})
	dominated := string(dominatedRaw)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		if pid, _ := body["playlistId"].(string); pid != "" {
			_, _ = w.Write([]byte(nextFixture))
			return
		}
		_, _ = w.Write([]byte(dominated))
	}))
	defer srv.Close()
	c := New(&fakeRunner{})
	c.NextEndpoint = srv.URL
	res, err := c.Related(context.Background(), "seed111")
	if err != nil {
		t.Fatal(err)
	}
	if !artistDominated(res.Tracks[:8]) || len(res.Tracks) != 10 {
		t.Fatalf("expected 8 queue tracks + 2 merged radio tracks (seed echo stripped), got %d", len(res.Tracks))
	}
	if res.Tracks[8].SourceID != "rel222" {
		t.Fatalf("merged radio tracks follow the queue, got %+v", res.Tracks[8])
	}
	if !shelfCounts(res, "queue", 8) || !shelfCounts(res, "radio", 2) {
		t.Fatalf("provenance must record both stages: %+v", res.Shelves)
	}
}

func shelfCounts(res model.RadioResponse, kind string, n int) bool {
	for _, sh := range res.Shelves {
		if sh.Kind == kind && sh.Count == n {
			return true
		}
	}
	return false
}

// ---------- metadata provenance + song-radio source selection ----------

func TestParseNextResponseRecordsProvenance(t *testing.T) {
	res, err := ParseNextResponse([]byte(watchAllSurfacesFixture))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	byID := map[string]model.Track{}
	for _, tr := range res.Tracks {
		byID[tr.SourceID] = tr
	}
	// Queue rows: artist from a music browse endpoint, queue renderer.
	if q := byID["f1"]; q.ArtistSrc != "browse" || q.Via != "playlistPanelVideoRenderer" {
		t.Fatalf("queue row provenance wrong: %+v", q)
	}
	// compactVideoRenderer with a "- Topic" channel => topic promotion.
	if r1 := byID["r1"]; r1.ArtistSrc != "topic" || r1.Via != "compactVideoRenderer" {
		t.Fatalf("topic row provenance wrong: %+v", r1)
	}
	// compactVideoRenderer with a bare channel => artist stays EMPTY, the
	// channel is uploader metadata only.
	if r2 := byID["r2"]; r2.ArtistSrc != "" || r2.Artist != "" || r2.Uploader != "Slowed Music Channel" {
		t.Fatalf("uploader-only row must not gain an artist: %+v", r2)
	}
	// Music-shelf rows: browse-identified artist + album.
	if s1 := byID["s1"]; s1.ArtistSrc != "browse" || s1.Via != "musicResponsiveListItemRenderer" {
		t.Fatalf("shelf row provenance wrong: %+v", s1)
	}
	// Tile rows carry the tile renderer; MYSSER is not a "- Topic" channel,
	// so no artist is inferred from the subtitle.
	if t9 := byID["t9"]; t9.Via != "musicTwoRowItemRenderer" || t9.Artist != "" || t9.Uploader != "MYSSER" {
		t.Fatalf("tile row provenance wrong: %+v", t9)
	}
}

// mixedRadioFixture: 8 rows, 3 Kordhell + 5 distinct artists — a genuinely
// mixed recommendation feed (37% top identity).
func mixedRadioFixture() string {
	rows := []map[string]any{}
	identities := []string{"Kordhell", "DYLAn", "Nohidea", "Kupla", "MYSSER", "Kordhell", "PXLWVYSE", "Kordhell"}
	for i, id := range identities {
		rows = append(rows, map[string]any{"playlistPanelVideoRenderer": map[string]any{
			"videoId": fmt.Sprintf("m%d", i),
			"title":   map[string]any{"runs": []map[string]any{{"text": fmt.Sprintf("Radio Song %d", i)}}},
			"longBylineText": map[string]any{"runs": []map[string]any{
				{"text": id, "navigationEndpoint": map[string]any{
					"browseEndpoint": map[string]any{"browseId": "UC" + id}}}}},
		}})
	}
	raw, _ := json.Marshal(map[string]any{
		"contents": map[string]any{"singleColumnMusicWatchNextResultsRenderer": map[string]any{
			"playlist": map[string]any{"playlist": map[string]any{"contents": rows}}}},
	})
	return string(raw)
}

// The Song Radio rule: an artist-heavy "Up next" queue must not define the
// radio when another fetched source is a genuinely mixed recommendation feed
// — the mixed source is promoted to lead, orders inside sources untouched.
func TestSongRadioSelectionPromotesMixedSource(t *testing.T) {
	var gotPlaylistID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		if pid, _ := body["playlistId"].(string); pid != "" {
			gotPlaylistID = pid
			_, _ = w.Write([]byte(mixedRadioFixture()))
			return
		}
		// The videoId answer: eight queue rows, all bxkq (artist-heavy).
		items := make([]map[string]any, 8)
		for i := range items {
			items[i] = map[string]any{"playlistPanelVideoRenderer": map[string]any{
				"videoId": fmt.Sprintf("g%d", i),
				"title":   map[string]any{"runs": []map[string]any{{"text": "FUNK"}}},
				"longBylineText": map[string]any{"runs": []map[string]any{
					{"text": "bxkq", "navigationEndpoint": map[string]any{
						"browseEndpoint": map[string]any{"browseId": "UCbxkq"}}}}},
			}}
		}
		raw, _ := json.Marshal(map[string]any{
			"contents": map[string]any{"singleColumnMusicWatchNextResultsRenderer": map[string]any{
				"playlist": map[string]any{"playlist": map[string]any{"contents": items}}}},
		})
		_, _ = w.Write(raw)
	}))
	defer srv.Close()
	c := New(&fakeRunner{err: fmt.Errorf("no yt-dlp")})
	c.NextEndpoint = srv.URL

	res, err := c.Related(context.Background(), "seed111")
	if err != nil {
		t.Fatal(err)
	}
	if gotPlaylistID != "RDAMVMseed111" {
		t.Fatalf("expected the RDAMVM song-radio request, got %q", gotPlaylistID)
	}
	// The mixed radio leads: first rows are the radio's, not the bxkq wall.
	if res.Tracks[0].SourceID != "m0" {
		t.Fatalf("mixed source must lead the song radio, got %s", res.Tracks[0].SourceID)
	}
	if res.Tracks[0].Artist != "Kordhell" {
		t.Fatalf("unexpected lead row: %+v", res.Tracks[0])
	}
	bxkq := 0
	for _, tr := range res.Tracks {
		if tr.Artist == "bxkq" {
			bxkq++
		}
	}
	if bxkq != 8 {
		t.Fatalf("artist-heavy queue must still contribute its rows (behind), got %d", bxkq)
	}
	if res.Shelves[0].Kind != "radio" {
		t.Fatalf("provenance must show the promoted source first: %+v", res.Shelves)
	}
	if res.Source != "ytmusic-next" {
		t.Fatalf("source tag: %s", res.Source)
	}
}

// With no mixed source available, the stage order stands — YouTube offered
// nothing broader and the provider must not invent candidates.
func TestSongRadioSelectionKeepsOrderWithoutMixedSource(t *testing.T) {
	heavy := []model.Track{
		{SourceID: "a", Artist: "X"}, {SourceID: "b", Artist: "X"}, {SourceID: "c", Artist: "X"},
		{SourceID: "d", Artist: "X"}, {SourceID: "e", Artist: "X"}, {SourceID: "f", Artist: "X"},
	}
	small := []model.Track{{SourceID: "g", Artist: "Y"}, {SourceID: "h", Artist: "Z"}}
	ordered := SelectRadioStages([]RadioStage{
		{Kind: "queue", Tracks: heavy},
		{Kind: "radio", Tracks: small}, // too small to prove a mixed feed
	})
	if ordered[0].Kind != "queue" || len(ordered) != 2 {
		t.Fatalf("order must stand when no source is genuinely mixed: %+v", ordered)
	}
}

// Diagnosis mode fetches every stage separately even when the first answer
// is already a healthy mixed feed.
func TestDiagnoseRelatedFetchesAllStagesSeparately(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case body["videoId"] != nil:
			_, _ = w.Write([]byte(nextFixture))
		case body["playlistId"] != nil:
			_, _ = w.Write([]byte(mixedRadioFixture()))
		default:
			_, _ = w.Write([]byte(`{"contents": {}}`))
		}
	}))
	defer srv.Close()
	c := New(&fakeRunner{err: fmt.Errorf("no yt-dlp")})
	c.NextEndpoint = srv.URL

	stages, err := c.DiagnoseRelated(context.Background(), "seed111")
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{}
	for _, st := range stages {
		kinds = append(kinds, st.Kind)
	}
	if len(kinds) < 2 || kinds[0] != "queue" || !contains(kinds, "radio") {
		t.Fatalf("diagnosis must fetch every stage separately, got %v", kinds)
	}
	for _, st := range stages {
		for _, tr := range st.Tracks {
			if tr.Via == "" {
				t.Fatalf("diagnostic rows must carry renderer provenance: %+v", tr)
			}
		}
	}
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

// ---------- provenance instrumentation for the K5v9A-uye6I diagnosis ----------

// The exact real shape reported from Windows: the seed-echo panel row of
// "Killers from the Northside - Kordhell" (video K5v9A-uye6I) carries its
// byline run "The Naghera" WITH a browse id — the uploading CHANNEL page,
// which also starts with UC. This test DOCUMENTS the current (wrong)
// behaviour: the run is promoted to Artist via the UC-browse branch and
// Uploader stays empty. It pins the behaviour so the upcoming identity fix
// must update it consciously.
func TestPanelRowDocumentsChannelBrowsePromotion(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{
		"contents": map[string]any{"singleColumnMusicWatchNextResultsRenderer": map[string]any{
			"playlist": map[string]any{"playlist": map[string]any{"contents": []map[string]any{
				{"playlistPanelVideoRenderer": map[string]any{
					"videoId": "K5v9A-uye6I",
					"title":   map[string]any{"runs": []map[string]any{{"text": "Killers from the Northside - Kordhell"}}},
					"longBylineText": map[string]any{"runs": []map[string]any{
						{"text": "The Naghera", "navigationEndpoint": map[string]any{
							"browseEndpoint": map[string]any{"browseId": "UCthenaghera"}}},
						{"text": " • "}, {"text": "3:41"}}},
				}},
			}}}},
		},
	})
	res, err := ParseNextResponse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tracks) != 1 {
		t.Fatalf("expected the echo row, got %d", len(res.Tracks))
	}
	row := res.Tracks[0]
	// Documented current behaviour (the mis-identification):
	if row.Artist != "The Naghera" || row.ArtistSrc != "browse" || row.Uploader != "" {
		t.Fatalf("documented behaviour changed: %+v", row)
	}
	// The instrumentation must expose the raw evidence: the browse id that
	// was treated as an artist link.
	if row.ArtistBrowseID != "UCthenaghera" {
		t.Fatalf("artist browse id not captured: %+v", row)
	}
}

func TestProvenanceCapturesBrowseIDs(t *testing.T) {
	res, err := ParseNextResponse([]byte(nextFixture))
	if err != nil {
		t.Fatal(err)
	}
	// rel222: artist run UC12345 + album run MPREb_9999.
	var rel model.Track
	for _, tr := range res.Tracks {
		if tr.SourceID == "rel222" {
			rel = tr
		}
	}
	if rel.ArtistBrowseID != "UC12345" || rel.AlbumBrowseID != "MPREb_9999" {
		t.Fatalf("browse ids not captured: %+v", rel)
	}
	// Search rows capture them too.
	sres, err := ParseSearchResponse([]byte(innerTubeFixture))
	if err != nil {
		t.Fatal(err)
	}
	if len(sres.Songs) == 0 || sres.Songs[0].ArtistBrowseID != "UC12345" {
		t.Fatalf("search song browse id not captured: %+v", sres.Songs)
	}
}

// The diagnosis report must include a section for EVERY source — even the
// ones that answer nothing — plus the automix-preview absence and the yt-dlp
// skip reason.
func TestDiagnoseRelatedReportsEmptySources(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"contents": {}}`))
	}))
	defer srv.Close()
	c := New(&fakeRunner{})
	c.NextEndpoint = srv.URL
	stages, err := c.DiagnoseRelated(context.Background(), "K5v9A-uye6I")
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]RadioStage{}
	for _, st := range stages {
		kinds[st.Kind] = st
	}
	for _, want := range []string{"queue", "related-videos", "music-shelves", "tiles", "automix", "radio", "ytdlp-mix"} {
		if _, ok := kinds[want]; !ok {
			t.Fatalf("diagnosis must report source %q even when empty; got %v", want, stageKinds(stages))
		}
	}
	if !strings.Contains(kinds["automix"].Note, "ABSENT") {
		t.Fatalf("automix preview absence must be reported: %q", kinds["automix"].Note)
	}
	if !strings.Contains(kinds["ytdlp-mix"].Note, "no yt-dlp runner") && !strings.Contains(kinds["ytdlp-mix"].Note, "failed") {
		t.Fatalf("yt-dlp skip reason must be reported: %q", kinds["ytdlp-mix"].Note)
	}
}

func stageKinds(stages []RadioStage) []string {
	out := []string{}
	for _, st := range stages {
		out = append(out, st.Kind)
	}
	return out
}

// ---------- self-echo is not a source (the Let Down / SLAVA FUNK fix) ----------

// A /next queue containing ONLY the seed echo must read as "source
// unavailable": the ladder continues to the RDAMVM song radio instead of
// returning a successful-looking one-row answer.
func TestSelfEchoQueueContinuesLadderToRadio(t *testing.T) {
	var requests []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case body["videoId"] != nil:
			requests = append(requests, "videoId")
			_, _ = w.Write([]byte(selfEchoFixture("seed111")))
		case body["playlistId"] != nil:
			requests = append(requests, "radio")
			_, _ = w.Write([]byte(nextFixture))
		default:
			requests = append(requests, "other")
			_, _ = w.Write([]byte(`{"contents": {}}`))
		}
	}))
	defer srv.Close()
	c := New(&fakeRunner{err: fmt.Errorf("no yt-dlp")})
	c.NextEndpoint = srv.URL
	res, err := c.Related(context.Background(), "seed111")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tracks) == 0 {
		t.Fatalf("the ladder must continue past a self-echo queue to the radio playlist")
	}
	for _, tr := range res.Tracks {
		if tr.SourceID == "seed111" {
			t.Fatalf("seed echo must never be delivered: %+v", tr)
		}
	}
	// The automix preview is absent in the fixture, so the continuation went
	// straight to the RDAMVM request.
	if !containsStr(requests, "radio") {
		t.Fatalf("RDAMVM song radio must be requested after a self-echo queue: %v", requests)
	}
}

// When EVERY recommendation source only echoes the seed, the provider
// honestly returns zero tracks — the frontend then prefers an empty Song
// Radio over fabricating one from artist search.
func TestSelfEchoEverywhereReturnsEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(selfEchoFixture("seed111")))
	}))
	defer srv.Close()
	c := New(&fakeRunner{err: fmt.Errorf("no yt-dlp")})
	c.NextEndpoint = srv.URL
	res, err := c.Related(context.Background(), "seed111")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Tracks) != 0 {
		t.Fatalf("a seed-only answer everywhere must yield zero usable tracks, got %+v", res.Tracks)
	}
}

func selfEchoFixture(videoID string) string {
	raw, _ := json.Marshal(map[string]any{
		"contents": map[string]any{"singleColumnMusicWatchNextResultsRenderer": map[string]any{
			"playlist": map[string]any{"playlist": map[string]any{"contents": []map[string]any{
				{"playlistPanelVideoRenderer": map[string]any{
					"videoId": videoID,
					"title":   map[string]any{"runs": []map[string]any{{"text": "The Seed Itself"}}},
					"longBylineText": map[string]any{"runs": []map[string]any{
						{"text": "Some Channel", "navigationEndpoint": map[string]any{
							"browseEndpoint": map[string]any{"browseId": "UCsomechannel"}}}}},
				}},
			}}}},
		},
	})
	return string(raw)
}

func containsStr(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
