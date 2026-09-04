package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"melo/internal/deps"
	"melo/internal/lyrics"
	"melo/internal/media"
	"melo/internal/model"
	"melo/internal/provider"
	"melo/internal/store"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails-bound surface. It owns the backend services and keeps them
// small: search, resolve, stream, lyrics, persist. Playback transport state
// lives in the renderer's media element; the queue lives in application state.
type App struct {
	ctx context.Context

	store    *store.Store
	deps     *deps.Manager
	provider *provider.Client
	resolver *media.Resolver
	proxy    *media.Proxy
	lyrics   *lyrics.Client

	mediaKeys *mediaKeyListener
	tray      *tray

	depMu      sync.Mutex
	depErr     error
	depChecked bool
}

type Diagnostics struct {
	AppVersion     string      `json:"appVersion"`
	GoVersion      string      `json:"goVersion"`
	Platform       string      `json:"platform"`
	DataDir        string      `json:"dataDir"`
	StreamProxy    string      `json:"streamProxy"`
	Resolver       deps.Status `json:"resolver"`
	ResolverBinary string      `json:"resolverBinary"`
	MediaKeys      string      `json:"mediaKeys"`
	Tray           string      `json:"tray"`
}

const appVersion = "3.0.0"

func NewApp() (*App, error) {
	dir, err := dataDir()
	if err != nil {
		return nil, err
	}
	st, err := store.Open(dir)
	if err != nil {
		return nil, err
	}
	dm, err := deps.NewManager(filepath.Join(dir, "bin"))
	if err != nil {
		return nil, err
	}
	app := &App{store: st, deps: dm, lyrics: lyrics.New()}

	runner := provider.Exec{Path: func() (string, error) {
		return app.resolverBinary()
	}}
	app.provider = provider.New(runner)
	app.resolver = media.NewResolver(runner)
	proxy, err := media.NewProxy(app.resolver)
	if err != nil {
		return nil, err
	}
	app.proxy = proxy
	app.proxy.SetQuality(st.State().Settings.AudioQuality)
	return app, nil
}

func dataDir() (string, error) {
	if custom := os.Getenv("MELO_DATA_DIR"); custom != "" {
		return custom, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("couldn't locate the user data folder: %w", err)
	}
	return filepath.Join(base, "MELO"), nil
}

// resolverBinary returns the managed yt-dlp path, installing it on first use.
func (a *App) resolverBinary() (string, error) {
	a.depMu.Lock()
	defer a.depMu.Unlock()
	if a.depChecked && a.depErr == nil {
		p, _ := a.deps.BinaryPath()
		return p, nil
	}
	path, err := a.deps.Ensure(func(done, total int64) {
		if a.ctx == nil || total <= 0 {
			return
		}
		wruntime.EventsEmit(a.ctx, "melo:resolver-progress", map[string]any{
			"done": done, "total": total,
		})
	})
	a.depChecked = true
	a.depErr = err
	if err != nil {
		return "", err
	}
	return path, nil
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	media.InitDiag()
	settings := a.store.State().Settings
	if settings.MediaKeys {
		a.mediaKeys = startMediaKeys(func(action string) {
			wruntime.EventsEmit(ctx, "melo:mediakey", action)
		})
	}
	a.applyTray(settings.MinimizeToTray)
	// Install the resolver in the background so first search/play is instant.
	go func() {
		if _, err := a.resolverBinary(); err != nil {
			wruntime.EventsEmit(ctx, "melo:resolver-error", err.Error())
			return
		}
		wruntime.EventsEmit(ctx, "melo:resolver-ready", a.deps.Version())
	}()
}

func (a *App) shutdown(context.Context) {
	if a.mediaKeys != nil {
		a.mediaKeys.Stop()
	}
	if a.tray != nil {
		a.tray.Stop()
		a.tray = nil
	}
	if a.proxy != nil {
		_ = a.proxy.Close()
	}
	if err := a.store.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "melo: failed to persist state on shutdown: %v\n", err)
	}
}

// ---------------- bound methods ----------------

func (a *App) GetState() model.AppState { return a.store.State() }

func (a *App) GetDiagnostics() Diagnostics {
	bin := ""
	if p, err := a.deps.BinaryPath(); err == nil {
		bin = p
	}
	return Diagnostics{
		AppVersion:     appVersion,
		GoVersion:      runtime.Version(),
		Platform:       runtime.GOOS + "/" + runtime.GOARCH,
		DataDir:        a.store.Dir(),
		StreamProxy:    a.proxy.Addr(),
		Resolver:       a.deps.Status(),
		ResolverBinary: bin,
		MediaKeys:      mediaKeySupport(),
		Tray:           traySupport(),
	}
}

func (a *App) Search(query, filter string) (model.SearchResponse, error) {
	ctx, cancel := context.WithTimeout(a.baseCtx(), 25*time.Second)
	defer cancel()
	res, err := a.provider.Search(ctx, query, filter)
	if err != nil {
		return res, err
	}
	return res, nil
}

// GetPlayable resolves a track to a loopback stream URL. Errors are surfaced
// verbatim to the UI so it can show a real message.
//
// The path is deliberately direct: the track's canonical provider id goes
// straight to the resolver (https://www.youtube.com/watch?v=<id>) — no text
// search, no metadata round trip. Timing diagnostics are printed when
// MELO_PLAY_LATENCY is set (see internal/media).
func (a *App) GetPlayable(track model.Track) (model.PlayableSource, error) {
	if track.SourceID == "" {
		return model.PlayableSource{}, errors.New("couldn't load this song: missing source id")
	}
	ctx, cancel := context.WithTimeout(a.baseCtx(), 45*time.Second)
	defer cancel()
	start := time.Now()
	if os.Getenv("MELO_PLAY_LATENCY") != "" {
		log.Printf("[play-latency] GET_PLAYABLE id=%s sourceId=%s", track.ID, track.SourceID)
	}
	res, err := a.resolver.Resolve(ctx, track.SourceID, a.proxy.Quality())
	if err != nil {
		return model.PlayableSource{}, err
	}
	if os.Getenv("MELO_PLAY_LATENCY") != "" {
		log.Printf("[play-latency] GET_PLAYABLE_END id=%s elapsed=%s (resolver cache/expiry above; loopback url ready)", track.ID, time.Since(start).Round(time.Millisecond))
	}
	return model.PlayableSource{
		TrackID:   track.ID,
		URL:       a.proxy.URLFor(track.SourceID),
		MimeType:  res.MimeType,
		Duration:  res.Duration,
		Bitrate:   res.Bitrate,
		ExpiresAt: res.ExpiresAt.UnixMilli(),
	}, nil
}

func (a *App) GetLyrics(q lyrics.Query) (lyrics.Result, error) {
	ctx, cancel := context.WithTimeout(a.baseCtx(), 15*time.Second)
	defer cancel()
	return a.lyrics.Fetch(ctx, q)
}

func (a *App) SaveSettings(s model.Settings) model.Settings {
	out := a.store.SaveSettings(s)
	a.proxy.SetQuality(out.AudioQuality)
	a.applyMediaKeys(out.MediaKeys)
	a.applyTray(out.MinimizeToTray)
	return out
}

func (a *App) applyMediaKeys(enabled bool) {
	if enabled && a.mediaKeys == nil && a.ctx != nil {
		a.mediaKeys = startMediaKeys(func(action string) {
			wruntime.EventsEmit(a.ctx, "melo:mediakey", action)
		})
		return
	}
	if !enabled && a.mediaKeys != nil {
		a.mediaKeys.Stop()
		a.mediaKeys = nil
	}
}

// applyTray starts or stops the tray icon to match the current setting.
func (a *App) applyTray(enabled bool) {
	if enabled && a.tray == nil && a.ctx != nil {
		a.tray = startTray(
			func(action string) { wruntime.EventsEmit(a.ctx, "melo:mediakey", action) },
			func() { wruntime.WindowShow(a.ctx); wruntime.WindowUnminimise(a.ctx) },
			func() { wruntime.Quit(a.ctx) },
		)
		return
	}
	if !enabled && a.tray != nil {
		a.tray.Stop()
		a.tray = nil
	}
}

// beforeClose hides the window to the tray instead of quitting when the user
// has asked for that; returning true tells Wails to cancel the close.
func (a *App) beforeClose(ctx context.Context) bool {
	if a.tray != nil && a.store.State().Settings.MinimizeToTray {
		wruntime.WindowHide(ctx)
		return true
	}
	return false
}

// SetNowPlaying updates the tray tooltip and, when enabled, raises a track
// change notification. Called by the renderer whenever the current track
// changes, so the desktop surfaces always match the real player.
// LogRadio forwards a frontend radio-lifecycle line (PLAY CURRENT / ON TRACK
// TRANSITION / ON REFILL / BEFORE DISCOVERY / AFTER DISCOVERY RESPONSE /
// DISCOVERY GENERATION / SOURCE / CANDIDATE) to the standard log when the app
// runs with MELO_RADIO_DEBUG=1 — the same terminal channel as the REQUEST/
// SEED/SOURCE blocks below, so queue-state transitions and provider calls can
// be read together. Diagnostics only.
func (a *App) LogRadio(line string) {
	if os.Getenv("MELO_RADIO_DEBUG") != "" {
		log.Printf("[radio-life] %s", strings.TrimRight(line, "\n"))
	}
}

func (a *App) SetNowPlaying(title, artist string) {
	if a.tray == nil {
		return
	}
	if title == "" {
		a.tray.SetTooltip("MELO")
		return
	}
	label := title
	if artist != "" {
		label = title + " — " + artist
	}
	a.tray.SetTooltip("MELO · " + label)
	if a.store.State().Settings.Notifications {
		a.tray.Notify(title, artist)
	}
}

func (a *App) SetLiked(t model.Track, liked bool) []model.Track { return a.store.SetLiked(t, liked) }
func (a *App) RecordPlay(t model.Track) []model.PlayRecord      { return a.store.RecordPlay(t) }
func (a *App) ClearHistory()                                    { a.store.ClearHistory() }

// Listening events & local taste (the recommendation engine's inputs).
func (a *App) RecordPlayEvent(t model.Track, event string) model.Taste {
	return a.store.RecordPlayEvent(t, event)
}
func (a *App) GetTaste() model.Taste { return a.store.Taste() }
func (a *App) SetDisliked(t model.Track, disliked bool) []model.Track {
	return a.store.SetDisliked(t, disliked)
}

// RelatedTracks returns the provider's dedicated related-music answer for a
// seed track — MELO radio's primary candidate source. Ordinary search is never
// used for autoplay while this endpoint yields candidates.
func (a *App) RelatedTracks(track model.Track) (model.RadioResponse, error) {
	if track.SourceID == "" {
		return model.RadioResponse{}, errors.New("couldn't load radio: missing source id")
	}
	ctx, cancel := context.WithTimeout(a.baseCtx(), 25*time.Second)
	defer cancel()
	res, err := a.provider.Related(ctx, track.SourceID)
	if err != nil {
		return model.RadioResponse{}, err
	}
	// The watch feed echoes the seed itself as the first queue entry; the
	// ranking stage drops it, but removing it here keeps the payload honest.
	filtered := make([]model.Track, 0, len(res.Tracks))
	for _, t := range res.Tracks {
		if t.ID != track.ID {
			filtered = append(filtered, t)
		}
	}
	if filtered == nil {
		filtered = []model.Track{}
	}
	if os.Getenv("MELO_RADIO_DEBUG") != "" {
		// Raw production evidence, printed to the terminal that launched the
		// app (run `set MELO_RADIO_DEBUG=1 && melo.exe` on Windows, or
		// MELO_RADIO_DEBUG=1 in a wails dev shell). One block per real
		// autoplay request: the REQUEST anchor, the SEED metadata with the
		// exact origin of its Artist value, which SOURCE stages contributed,
		// and every CANDIDATE with position/artist/uploader/provenance.
		log.Printf("[radio] REQUEST related anchor=VIDEO ID:%s (this playback generation)",
			track.SourceID)
		log.Printf("[radio] SEED VIDEO ID:%s | title=%q | ARTIST:%q | ARTIST SOURCE:%s | UPLOADER:%q (channelId:%s) | artistBrowseId:%s | album=%q (albumBrowseId:%s) | via=%s",
			track.SourceID, track.Title, track.Artist, artistSrcLabelApp(track.ArtistSrc),
			track.Uploader, track.UploaderChannelID, track.ArtistBrowseID,
			track.Album, track.AlbumBrowseID, track.Via)
		for _, sh := range res.Shelves {
			log.Printf("[radio] SOURCE %s -> %d candidates (in final order this source leads: %s)",
				sh.Kind, sh.Count, res.Source)
		}
		for i, t := range filtered {
			log.Printf("[radio] CANDIDATE POSITION:%d | %q | ARTIST:%q | ARTIST SOURCE:%s | UPLOADER:%q | VIDEO ID:%s | via=%s",
				i+1, truncate(t.Title, 40), t.Artist, artistSrcLabelApp(t.ArtistSrc), t.Uploader, t.SourceID, t.Via)
		}
	}
	return model.RadioResponse{Tracks: filtered, Source: res.Source, Shelves: res.Shelves}, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}

func artistSrcLabelApp(src string) string {
	switch src {
	case "browse":
		return "music-browse-run"
	case "topic":
		return "topic-channel"
	case "metadata":
		return "yt-dlp-metadata"
	case "":
		return "NONE"
	default:
		return src
	}
}
func (a *App) AddSearchTerm(q string) []string    { return a.store.AddSearchTerm(q) }
func (a *App) RemoveSearchTerm(q string) []string { return a.store.RemoveSearchTerm(q) }
func (a *App) ClearSearchHistory()                { a.store.ClearSearchHistory() }
func (a *App) LibraryTracks() []model.Track       { return a.store.LibraryTracks() }
func (a *App) SaveSession(s model.Session)        { a.store.SaveSession(s) }
func (a *App) ClearSession()                      { a.store.ClearSession() }

func (a *App) CreatePlaylist(name string, tracks []model.Track) model.Playlist {
	return a.store.CreatePlaylist(name, tracks)
}
func (a *App) RenamePlaylist(id, name string) (model.Playlist, error) {
	return a.store.RenamePlaylist(id, name)
}
func (a *App) DeletePlaylist(id string) error { return a.store.DeletePlaylist(id) }
func (a *App) AddTracksToPlaylist(id string, tracks []model.Track) (model.Playlist, error) {
	return a.store.AddTracksToPlaylist(id, tracks)
}
func (a *App) RemoveTrackFromPlaylist(id string, index int) (model.Playlist, error) {
	return a.store.RemoveTrackFromPlaylist(id, index)
}
func (a *App) ReorderPlaylist(id string, from, to int) (model.Playlist, error) {
	return a.store.ReorderPlaylist(id, from, to)
}
func (a *App) DuplicatePlaylist(id string) (model.Playlist, error) {
	return a.store.DuplicatePlaylist(id)
}

// InstallResolver lets the UI retry a failed dependency install explicitly.
func (a *App) InstallResolver() (deps.Status, error) {
	a.depMu.Lock()
	a.depChecked = false
	a.depErr = nil
	a.depMu.Unlock()
	if _, err := a.resolverBinary(); err != nil {
		return a.deps.Status(), err
	}
	return a.deps.Status(), nil
}

func (a *App) baseCtx() context.Context {
	if a.ctx != nil {
		return a.ctx
	}
	return context.Background()
}
