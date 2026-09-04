// Package model contains the shared domain types exchanged between the Go
// backend and the React frontend. These are the single source of truth for the
// generated TypeScript bindings.
package model

// Track is the canonical representation of a playable item. It is produced by
// the search provider and stored in the library; the resolver turns it into a
// PlayableSource. The player itself never knows where a track came from.
type Track struct {
	ID       string  `json:"id"`       // provider-scoped id, e.g. "yt:dQw4w9WgXcQ"
	SourceID string  `json:"sourceId"` // raw provider id, e.g. "dQw4w9WgXcQ"
	Source   string  `json:"source"`   // "youtube"
	URL      string  `json:"url"`      // canonical web URL, when meaningful
	Title    string  `json:"title"`
	Artist   string  `json:"artist"`             // performing artist, only when the provider identifies one
	Uploader string  `json:"uploader,omitempty"` // channel/uploader when it is NOT the performing artist
	Album    string  `json:"album"`              // empty when the provider has no album
	Artwork  string  `json:"artwork"`            // real provider artwork URL, may be empty
	Duration float64 `json:"duration"`           // seconds; 0 when unknown
	Explicit bool    `json:"explicit"`
	AddedAt  int64   `json:"addedAt,omitempty"`

	// ---- diagnostics (never used for ranking or persistence logic) ----
	// ArtistSrc records WHERE the Artist value came from, so "uploader leaked
	// into artist" can be told apart from "the provider identified the
	// artist": "browse" = a music browse endpoint explicitly named the
	// artist; "topic" = an official "<Artist> - Topic" channel; "" = no
	// artist identified (uploader/channel only).
	ArtistSrc string `json:"artistSrc,omitempty"`
	// Via records which renderer/endpoint produced the row, e.g.
	// "playlistPanelVideoRenderer" or "compactVideoRenderer".
	Via string `json:"via,omitempty"`
	// ArtistBrowseID is the raw browse id of the first artist-linked run
	// (diagnostics only — a UC id here does NOT by itself prove an artist:
	// personal channel pages carry UC ids too).
	ArtistBrowseID string `json:"artistBrowseId,omitempty"`
	// UploaderChannelID is the raw channel browse id of the uploader run
	// (diagnostics only).
	UploaderChannelID string `json:"uploaderChannelId,omitempty"`
	// AlbumBrowseID is the raw MPRE browse id of the album run (diagnostics only).
	AlbumBrowseID string `json:"albumBrowseId,omitempty"`
}

// SearchResult groups provider results by kind so the UI can render sections.
type SearchResponse struct {
	Query    string   `json:"query"`
	Songs    []Track  `json:"songs"`
	Videos   []Track  `json:"videos"`
	Albums   []Album  `json:"albums"`
	Artists  []Artist `json:"artists"`
	Provider string   `json:"provider"` // "ytmusic" | "yt-dlp"
}

type Album struct {
	ID      string  `json:"id"`
	Title   string  `json:"title"`
	Artist  string  `json:"artist"`
	Artwork string  `json:"artwork"`
	Year    string  `json:"year"`
	Tracks  []Track `json:"tracks,omitempty"`
}

type Artist struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Artwork string  `json:"artwork"`
	Tracks  []Track `json:"tracks,omitempty"`
	Albums  []Album `json:"albums,omitempty"`
}

// PlayableSource is what the resolver hands to the player. The URL is always a
// local streaming-proxy URL so the webview media element can range-request it
// without provider auth/CORS concerns.
type PlayableSource struct {
	TrackID   string  `json:"trackId"`
	URL       string  `json:"url"`
	MimeType  string  `json:"mimeType"`
	Duration  float64 `json:"duration"`
	Bitrate   int     `json:"bitrate"`
	ExpiresAt int64   `json:"expiresAt"`
}

// Playlist is a user-owned, locally persisted collection.
type Playlist struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Tracks      []Track `json:"tracks"`
	CreatedAt   int64   `json:"createdAt"`
	UpdatedAt   int64   `json:"updatedAt"`
}

// PlayRecord is one real playback event (recorded once playback actually starts).
type PlayRecord struct {
	Track    Track `json:"track"`
	PlayedAt int64 `json:"playedAt"`
}

// Play events recorded by the renderer. They are coarse on purpose: the player
// emits at most a handful per track, never per transport-state update.
const (
	PlayStarted         = "play_started"         // playback of the track actually began
	PlayedSignificantly = "played_significantly" // crossed the "real listen" threshold
	PlayCompleted       = "completed"            // reached the natural end of file
	PlaySkipped         = "skipped"              // the user moved on before a real listen
)

// PlayStats aggregates the listening events for one track. It is the local,
// bounded "taste" signal the recommendation engine reads.
type PlayStats struct {
	PlayCount        int   `json:"playCount"`
	SignificantCount int   `json:"significantCount"`
	CompleteCount    int   `json:"completeCount"`
	SkipCount        int   `json:"skipCount"`
	LastPlayedAt     int64 `json:"lastPlayedAt"`
}

// Taste is everything the frontend needs to personalise discovery, delivered
// as one payload so a single event can update history, stats and dislikes.
type Taste struct {
	History  []PlayRecord         `json:"history"`
	Stats    map[string]PlayStats `json:"stats"`
	Disliked []Track              `json:"disliked"`
}

// RadioResponse is the provider's dedicated related-music answer for a seed
// track. Source documents which pipeline produced the candidates, e.g.
// "ytmusic-next" (the YouTube Music watch-next radio) or "yt-dlp-mix".
type RadioResponse struct {
	Tracks []Track `json:"tracks"`
	Source string  `json:"source"`
	// Shelves records which recommendation surfaces of the watch-next page
	// contributed how many candidates (queue panel, related-video shelves,
	// music shelves, the automix continuation, the RDAMVM song-radio playlist).
	// Pure diagnostics: it explains, per real response, where candidates came
	// from — the frontend logs it in dev builds.
	Shelves []RadioShelf `json:"shelves,omitempty"`
}

// RadioShelf is one recommendation surface's contribution to a RadioResponse.
type RadioShelf struct {
	Kind  string `json:"kind"`
	Count int    `json:"count"`
}

type Settings struct {
	Theme           string            `json:"theme"`           // "dark" | "light" | "system"
	Accent          string            `json:"accent"`          // accent key
	Autoplay        bool              `json:"autoplay"`        // continue after explicit queue ends
	DefaultSpeed    float64           `json:"defaultSpeed"`    // 0.5 - 2.0
	AudioQuality    string            `json:"audioQuality"`    // "high" | "medium" | "low"
	RestoreSession  bool              `json:"restoreSession"`  // restore last track/queue on launch
	ResumeOnStartup bool              `json:"resumeOnStartup"` // auto-resume playback on launch
	MediaKeys       bool              `json:"mediaKeys"`       // OS media key control
	MinimizeToTray  bool              `json:"minimizeToTray"`  // tray icon + close-to-tray (Windows)
	Notifications   bool              `json:"notifications"`   // balloon notification on track change
	ShowLyrics      bool              `json:"showLyrics"`
	Volume          float64           `json:"volume"`
	Muted           bool              `json:"muted"`
	Shortcuts       map[string]string `json:"shortcuts"`
}

// Session is the optional restorable playback state.
type Session struct {
	Queue     []Track `json:"queue"`
	AutoQueue []Track `json:"autoQueue"`
	Index     int     `json:"index"`
	Position  float64 `json:"position"`
	Shuffle   bool    `json:"shuffle"`
	Repeat    string  `json:"repeat"` // "off" | "one" | "all"
	Speed     float64 `json:"speed"`
	SavedAt   int64   `json:"savedAt"`
}

// AppState is the full persisted state handed to the frontend on boot.
type AppState struct {
	Settings      Settings             `json:"settings"`
	Liked         []Track              `json:"liked"`
	Disliked      []Track              `json:"disliked"`
	Playlists     []Playlist           `json:"playlists"`
	History       []PlayRecord         `json:"history"`
	Stats         map[string]PlayStats `json:"stats"`
	SearchHistory []string             `json:"searchHistory"`
	Session       *Session             `json:"session"`
	Version       int                  `json:"version"`
}

func DefaultSettings() Settings {
	return Settings{
		Theme:           "dark",
		Accent:          "ember",
		Autoplay:        true,
		DefaultSpeed:    1,
		AudioQuality:    "high",
		RestoreSession:  true,
		ResumeOnStartup: false,
		MediaKeys:       true,
		MinimizeToTray:  true,
		Notifications:   true,
		ShowLyrics:      true,
		Volume:          0.9,
		Muted:           false,
		Shortcuts: map[string]string{
			"playPause":  "Space",
			"next":       "Ctrl+Right",
			"previous":   "Ctrl+Left",
			"seekFwd":    "Right",
			"seekBack":   "Left",
			"volumeUp":   "Up",
			"volumeDown": "Down",
			"mute":       "M",
			"shuffle":    "S",
			"repeat":     "R",
			"like":       "L",
			"search":     "Ctrl+K",
			"queue":      "Q",
			"lyrics":     "Y",
		},
	}
}
