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
	Artist   string  `json:"artist"`
	Album    string  `json:"album"`    // empty when the provider has no album
	Artwork  string  `json:"artwork"`  // real provider artwork URL, may be empty
	Duration float64 `json:"duration"` // seconds; 0 when unknown
	Explicit bool    `json:"explicit"`
	AddedAt  int64   `json:"addedAt,omitempty"`
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
	Settings      Settings     `json:"settings"`
	Liked         []Track      `json:"liked"`
	Playlists     []Playlist   `json:"playlists"`
	History       []PlayRecord `json:"history"`
	SearchHistory []string     `json:"searchHistory"`
	Session       *Session     `json:"session"`
	Version       int          `json:"version"`
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
