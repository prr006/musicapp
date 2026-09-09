package api

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode"

	"melo/internal/deps"
	"melo/internal/lyrics"
	"melo/internal/media"
	"melo/internal/model"
	"melo/server/auth"
	"melo/server/cache"
	"melo/server/config"
	accountstore "melo/server/store"
)

const maxJSONBody = 2 << 20

type SearchProvider interface {
	Search(context.Context, string, string) (model.SearchResponse, error)
}

type LyricsProvider interface {
	Fetch(context.Context, lyrics.Query) (lyrics.Result, error)
}

type Resolver interface {
	Resolve(context.Context, string, string) (media.Resolved, error)
}

type Dependencies struct {
	Config       config.Config
	Auth         *auth.Service
	Accounts     accountstore.Repository
	Provider     SearchProvider
	Resolver     Resolver
	Streamer     *media.Streamer
	Lyrics       LyricsProvider
	ResolverInfo func() deps.Status
	Logger       *slog.Logger
}

type Server struct {
	cfg            config.Config
	auth           *auth.Service
	accounts       accountstore.Repository
	provider       SearchProvider
	resolver       Resolver
	streamer       *media.Streamer
	lyrics         LyricsProvider
	resolverInfo   func() deps.Status
	logger         *slog.Logger
	searchCache    *cache.Group[model.SearchResponse]
	lyricsCache    *cache.Group[lyrics.Result]
	radioCache     *cache.Group[model.RadioSession]
	recommendCache *cache.Group[model.Recommendations]
	providerBreak  *cache.Breaker
	globalLimit    *rateLimiter
	searchLimit    *rateLimiter
	resolveLimit   *rateLimiter
	authLimit      *rateLimiter
	streamLimit    *rateLimiter
	streamSlots    chan struct{}
}

func New(dependencies Dependencies) http.Handler {
	s := &Server{
		cfg: dependencies.Config, auth: dependencies.Auth, accounts: dependencies.Accounts, provider: dependencies.Provider,
		resolver: dependencies.Resolver, streamer: dependencies.Streamer, lyrics: dependencies.Lyrics,
		resolverInfo: dependencies.ResolverInfo, logger: dependencies.Logger,
		searchCache: cache.NewGroup[model.SearchResponse](), lyricsCache: cache.NewGroup[lyrics.Result](),
		radioCache: cache.NewGroup[model.RadioSession](), recommendCache: cache.NewGroup[model.Recommendations](),
		providerBreak: cache.NewBreaker(5, 30*time.Second),
		globalLimit:   newRateLimiter(240, 80), searchLimit: newRateLimiter(60, 20),
		resolveLimit: newRateLimiter(20, 6), authLimit: newRateLimiter(20, 5),
		streamLimit: newRateLimiter(600, 100),
		streamSlots: make(chan struct{}, 48),
	}
	if s.logger == nil {
		s.logger = slog.Default()
	}
	if s.resolverInfo == nil {
		s.resolverInfo = func() deps.Status { return deps.Status{Message: "server managed"} }
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /ready", s.ready)
	mux.HandleFunc("GET /api/v1/me", s.me)
	mux.HandleFunc("POST /api/v1/auth/register", s.register)
	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	mux.HandleFunc("POST /api/v1/auth/logout", s.logout)
	mux.HandleFunc("GET /api/v1/diagnostics", s.diagnostics)
	mux.HandleFunc("GET /api/v1/state", s.getState)
	mux.HandleFunc("GET /api/v1/library", s.libraryTracks)
	mux.HandleFunc("PUT /api/v1/settings", s.saveSettings)
	mux.HandleFunc("POST /api/v1/library/likes", s.like)
	mux.HandleFunc("DELETE /api/v1/library/likes", s.unlike)
	mux.HandleFunc("POST /api/v1/history", s.recordPlay)
	mux.HandleFunc("DELETE /api/v1/history", s.clearHistory)
	mux.HandleFunc("POST /api/v1/search-history", s.addSearchHistory)
	mux.HandleFunc("DELETE /api/v1/search-history", s.deleteSearchHistory)
	mux.HandleFunc("PUT /api/v1/session", s.saveSession)
	mux.HandleFunc("DELETE /api/v1/session", s.clearSession)
	mux.HandleFunc("GET /api/v1/search", s.search)
	mux.HandleFunc("GET /api/v1/suggest", s.suggest)
	mux.HandleFunc("GET /api/v1/radio/{kind}/{id}", s.radio)
	mux.HandleFunc("GET /api/v1/recommendations", s.recommendations)
	mux.HandleFunc("GET /api/v1/home", s.recommendations)
	mux.HandleFunc("POST /api/v1/resolve", s.resolve)
	mux.HandleFunc("GET /api/v1/resolve/{id}", s.resolveByID)
	mux.HandleFunc("GET /api/v1/stream/{id}", s.stream)
	mux.HandleFunc("HEAD /api/v1/stream/{id}", s.stream)
	mux.HandleFunc("POST /api/v1/lyrics", s.getLyrics)
	mux.HandleFunc("POST /api/v1/events/playback-error", s.playbackError)
	mux.HandleFunc("GET /api/v1/playlists", s.listPlaylists)
	mux.HandleFunc("POST /api/v1/playlists", s.createPlaylist)
	mux.HandleFunc("PATCH /api/v1/playlists/{id}", s.renamePlaylist)
	mux.HandleFunc("DELETE /api/v1/playlists/{id}", s.deletePlaylist)
	mux.HandleFunc("POST /api/v1/playlists/{id}/tracks", s.addPlaylistTracks)
	mux.HandleFunc("DELETE /api/v1/playlists/{id}/tracks", s.removePlaylistTrack)
	mux.HandleFunc("PATCH /api/v1/playlists/{id}/tracks", s.reorderPlaylist)
	mux.HandleFunc("POST /api/v1/playlists/{id}/duplicate", s.duplicatePlaylist)

	var handler http.Handler = mux
	handler = s.auth.Middleware(handler)
	handler = s.recover(handler)
	handler = s.rateLimit(handler)
	handler = s.logRequests(handler)
	handler = s.securityHeaders(handler)
	handler = s.cors(handler)
	handler = s.requestID(handler)
	return handler
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "melo-api", "version": "3.1.0"})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if err := s.accounts.Ready(r.Context()); err != nil {
		s.logger.Error("storage readiness failed", "stage", "storage_ready", "request_id", requestID(r), "error", err)
		writeError(w, http.StatusServiceUnavailable, "not_ready", "storage is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, auth.FromContext(r.Context()))
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	if !s.authLimit.allow(clientIP(r, s.cfg.TrustProxyHeaders)) {
		writeRateLimited(w)
		return
	}
	var body credentials
	if !decodeJSON(w, r, &body) {
		return
	}
	identity, err := s.auth.Register(w, body.Username, body.Password)
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, auth.ErrUserExists) {
			code = http.StatusConflict
		}
		writeError(w, code, "registration_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, identity)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.authLimit.allow(clientIP(r, s.cfg.TrustProxyHeaders)) {
		writeRateLimited(w)
		return
	}
	var body credentials
	if !decodeJSON(w, r, &body) {
		return
	}
	identity, err := s.auth.Login(w, body.Username, body.Password)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", auth.ErrCredentials.Error())
		return
	}
	writeJSON(w, http.StatusOK, identity)
}

func (s *Server) logout(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.auth.Logout(w))
}

func (s *Server) diagnostics(w http.ResponseWriter, _ *http.Request) {
	status := s.resolverInfo()
	// Hosted diagnostics deliberately omit server filesystem paths.
	status.Path = ""
	writeJSON(w, http.StatusOK, map[string]any{
		"appVersion": "3.1.0-web", "goVersion": runtime.Version(), "platform": "web-api/" + runtime.GOOS,
		"dataDir": "server-managed account storage", "streamProxy": "/api/v1/stream",
		"resolver": status, "resolverBinary": "server-managed", "mediaKeys": "browser-media-session", "tray": "browser",
	})
}

func (s *Server) account(r *http.Request) (accountstore.Library, error) {
	return s.accounts.ForSubject(r.Context(), auth.FromContext(r.Context()).Subject)
}

func (s *Server) getState(w http.ResponseWriter, r *http.Request) {
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, account.State())
}

func (s *Server) libraryTracks(w http.ResponseWriter, r *http.Request) {
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, account.LibraryTracks())
}

func (s *Server) saveSettings(w http.ResponseWriter, r *http.Request) {
	var settings model.Settings
	if !decodeJSON(w, r, &settings) {
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, account.SaveSettings(settings))
}

func (s *Server) like(w http.ResponseWriter, r *http.Request)   { s.setLiked(w, r, true) }
func (s *Server) unlike(w http.ResponseWriter, r *http.Request) { s.setLiked(w, r, false) }

func (s *Server) setLiked(w http.ResponseWriter, r *http.Request, liked bool) {
	var track model.Track
	if !decodeJSON(w, r, &track) || !validateTrack(w, track) {
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, account.SetLiked(track, liked))
}

func (s *Server) recordPlay(w http.ResponseWriter, r *http.Request) {
	var track model.Track
	if !decodeJSON(w, r, &track) || !validateTrack(w, track) {
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, account.RecordPlay(track))
}

func (s *Server) clearHistory(w http.ResponseWriter, r *http.Request) {
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	account.ClearHistory()
	w.WriteHeader(http.StatusNoContent)
}

type searchTermBody struct {
	Term string `json:"term"`
}

func (s *Server) addSearchHistory(w http.ResponseWriter, r *http.Request) {
	var body searchTermBody
	if !decodeJSON(w, r, &body) {
		return
	}
	if len(body.Term) > 200 {
		writeError(w, http.StatusBadRequest, "invalid_term", "search term is too long")
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, account.AddSearchTerm(body.Term))
}

func (s *Server) deleteSearchHistory(w http.ResponseWriter, r *http.Request) {
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	term := r.URL.Query().Get("term")
	if term == "" {
		account.ClearSearchHistory()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, account.RemoveSearchTerm(term))
}

func (s *Server) saveSession(w http.ResponseWriter, r *http.Request) {
	var session model.Session
	if !decodeJSON(w, r, &session) {
		return
	}
	if len(session.Queue)+len(session.AutoQueue) > 2000 || session.Index < -1 {
		writeError(w, http.StatusBadRequest, "invalid_session", "invalid or oversized playback session")
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	account.SaveSession(session)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) clearSession(w http.ResponseWriter, r *http.Request) {
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	account.ClearSession()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	filter := strings.TrimSpace(r.URL.Query().Get("filter"))
	if len(query) < 1 || len(query) > 200 || !validFilter(filter) {
		writeError(w, http.StatusBadRequest, "invalid_search", "q must be 1–200 characters and filter must be a supported type")
		return
	}
	if !s.searchLimit.allow(clientIP(r, s.cfg.TrustProxyHeaders)) {
		writeRateLimited(w)
		return
	}
	result, err := s.cachedSearch(r.Context(), query, filter)
	if err != nil {
		s.logStageFailure(r, "search", err, "filter", filter, "query_length", len(query))
		writeSearchError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) suggest(w http.ResponseWriter, r *http.Request) {
	if !s.searchLimit.allow(clientIP(r, s.cfg.TrustProxyHeaders)) {
		writeRateLimited(w)
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) < 1 || len(query) > 200 {
		writeError(w, http.StatusBadRequest, "invalid_search", "q must be 1–200 characters")
		return
	}
	result, err := s.cachedSearch(r.Context(), query, "")
	if err != nil {
		s.logStageFailure(r, "suggest", err, "query_length", len(query))
		writeSearchError(w, err)
		return
	}
	if len(result.Songs) > 6 {
		result.Songs = result.Songs[:6]
	}
	if len(result.Videos) > 2 {
		result.Videos = result.Videos[:2]
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) cachedSearch(ctx context.Context, query, filter string) (model.SearchResponse, error) {
	key := strings.ToLower(strings.TrimSpace(query)) + "|" + filter
	return s.searchCache.Get(ctx, key, 2*time.Minute, func(loadCtx context.Context) (model.SearchResponse, error) {
		var result model.SearchResponse
		err := s.providerBreak.Do(loadCtx, func(breakerCtx context.Context) error {
			requestCtx, cancel := context.WithTimeout(breakerCtx, s.cfg.SearchTimeout)
			defer cancel()
			var err error
			result, err = s.provider.Search(requestCtx, query, filter)
			return err
		})
		normalizeSearch(&result)
		return result, err
	})
}

func normalizeSearch(result *model.SearchResponse) {
	if result.Songs == nil {
		result.Songs = []model.Track{}
	}
	if result.Videos == nil {
		result.Videos = []model.Track{}
	}
	if result.Albums == nil {
		result.Albums = []model.Album{}
	}
	if result.Artists == nil {
		result.Artists = []model.Artist{}
	}
}

func (s *Server) resolve(w http.ResponseWriter, r *http.Request) {
	var track model.Track
	if !decodeJSON(w, r, &track) || !validateTrack(w, track) {
		return
	}
	s.resolveTrack(w, r, track.ID, track.SourceID)
}

func (s *Server) resolveByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validSourceID(id) {
		writeError(w, http.StatusBadRequest, "invalid_track_id", "invalid provider track id")
		return
	}
	s.resolveTrack(w, r, "yt:"+id, id)
}

func (s *Server) resolveTrack(w http.ResponseWriter, r *http.Request, trackID, sourceID string) {
	if !s.resolveLimit.allow(clientIP(r, s.cfg.TrustProxyHeaders)) {
		writeRateLimited(w)
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	quality := account.State().Settings.AudioQuality
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.ResolveTimeout)
	defer cancel()
	resolved, err := s.resolver.Resolve(ctx, sourceID, quality)
	if err != nil {
		s.logStageFailure(r, "resolve", err, "source_id", sourceID, "quality", quality)
		writeResolveError(w, err)
		return
	}
	expires := time.Now().Add(2 * time.Hour).Unix()
	if !resolved.ExpiresAt.IsZero() && resolved.ExpiresAt.Add(-30*time.Second).Unix() < expires {
		expires = resolved.ExpiresAt.Add(-30 * time.Second).Unix()
	}
	if expires <= time.Now().Unix() {
		err := errors.New("resolver returned a source too close to expiry")
		s.logStageFailure(r, "signed_source", err, "source_id", sourceID)
		writeError(w, http.StatusBadGateway, "expired_source", "Playback source expired. Retry the track.")
		return
	}
	signature := s.playbackSignature(sourceID, expires)
	url := fmt.Sprintf("/api/v1/stream/%s?expires=%d&signature=%s", sourceID, expires, signature)
	writeJSON(w, http.StatusOK, model.PlayableSource{
		TrackID: trackID, URL: url, MimeType: resolved.MimeType, Duration: resolved.Duration,
		Bitrate: resolved.Bitrate, ExpiresAt: expires * 1000,
	})
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	expires, err := strconv.ParseInt(r.URL.Query().Get("expires"), 10, 64)
	signature := r.URL.Query().Get("signature")
	if err != nil || !validSourceID(id) || expires < time.Now().Unix() || !hmac.Equal([]byte(signature), []byte(s.playbackSignature(id, expires))) {
		safeSourceID := ""
		if validSourceID(id) {
			safeSourceID = id
		}
		s.logger.Warn("signed playback source rejected", "stage", "signed_source", "request_id", requestID(r), "source_id", safeSourceID, "expired", expires > 0 && expires < time.Now().Unix())
		writeError(w, http.StatusForbidden, "invalid_playback_ticket", "Playback source expired or is invalid. Resolve the track again.")
		return
	}
	if !s.streamLimit.allow(clientIP(r, s.cfg.TrustProxyHeaders)) {
		writeRateLimited(w)
		return
	}
	select {
	case s.streamSlots <- struct{}{}:
		defer func() { <-s.streamSlots }()
	case <-r.Context().Done():
		return
	default:
		writeError(w, http.StatusServiceUnavailable, "stream_capacity", "playback service is busy; retry shortly")
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	s.streamer.Serve(w, r, id, account.State().Settings.AudioQuality)
}

func (s *Server) playbackSignature(id string, expires int64) string {
	mac := hmac.New(sha256.New, s.cfg.PlaybackSecret)
	_, _ = fmt.Fprintf(mac, "%s|%d", id, expires)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Server) getLyrics(w http.ResponseWriter, r *http.Request) {
	var query lyrics.Query
	if !decodeJSON(w, r, &query) {
		return
	}
	if len(query.TrackID) > 200 || len(query.Title) < 1 || len(query.Title) > 500 || len(query.Artist) > 500 {
		writeError(w, http.StatusBadRequest, "invalid_lyrics_query", "invalid lyrics query")
		return
	}
	key := strings.ToLower(query.TrackID + "|" + query.Artist + "|" + query.Title)
	result, err := s.lyricsCache.Get(r.Context(), key, 24*time.Hour, func(ctx context.Context) (lyrics.Result, error) {
		requestCtx, cancel := context.WithTimeout(ctx, s.cfg.LyricsTimeout)
		defer cancel()
		return s.lyrics.Fetch(requestCtx, query)
	})
	if err != nil {
		if errors.Is(err, lyrics.ErrNotFound) {
			writeError(w, http.StatusNotFound, "lyrics_not_found", "No lyrics found.")
		} else {
			s.logStageFailure(r, "lyrics", err, "track_id", query.TrackID)
			writeLyricsError(w, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type playbackErrorBody struct {
	TrackID     string `json:"trackId"`
	Code        string `json:"code"`
	Recoverable bool   `json:"recoverable"`
}

func (s *Server) playbackError(w http.ResponseWriter, r *http.Request) {
	var body playbackErrorBody
	if !decodeJSON(w, r, &body) {
		return
	}
	if len(body.TrackID) > 200 || len(body.Code) < 1 || len(body.Code) > 80 {
		writeError(w, http.StatusBadRequest, "invalid_playback_event", "invalid playback diagnostic")
		return
	}
	for _, char := range body.Code {
		if !(char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '_' || char == '-') {
			writeError(w, http.StatusBadRequest, "invalid_playback_event", "invalid playback diagnostic")
			return
		}
	}
	s.logger.Warn("browser playback failure",
		"stage", "browser_playback",
		"request_id", requestID(r),
		"track_id", body.TrackID,
		"code", body.Code,
		"recoverable", body.Recoverable,
	)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listPlaylists(w http.ResponseWriter, r *http.Request) {
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, account.State().Playlists)
}

type playlistBody struct {
	Name   string        `json:"name"`
	Tracks []model.Track `json:"tracks,omitempty"`
}

func (s *Server) createPlaylist(w http.ResponseWriter, r *http.Request) {
	var body playlistBody
	if !decodeJSON(w, r, &body) || !validatePlaylistInput(w, body.Name, body.Tracks) {
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, account.CreatePlaylist(body.Name, body.Tracks))
}

func (s *Server) renamePlaylist(w http.ResponseWriter, r *http.Request) {
	var body playlistBody
	if !decodeJSON(w, r, &body) || !validatePlaylistInput(w, body.Name, nil) {
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	playlist, err := account.RenamePlaylist(r.PathValue("id"), body.Name)
	writePlaylistResult(w, playlist, err)
}

func (s *Server) deletePlaylist(w http.ResponseWriter, r *http.Request) {
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	if err := account.DeletePlaylist(r.PathValue("id")); err != nil {
		writeError(w, http.StatusNotFound, "playlist_not_found", "playlist not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type tracksBody struct {
	Tracks []model.Track `json:"tracks"`
}

func (s *Server) addPlaylistTracks(w http.ResponseWriter, r *http.Request) {
	var body tracksBody
	if !decodeJSON(w, r, &body) || !validateTracks(w, body.Tracks) {
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	playlist, err := account.AddTracksToPlaylist(r.PathValue("id"), body.Tracks)
	writePlaylistResult(w, playlist, err)
}

func (s *Server) removePlaylistTrack(w http.ResponseWriter, r *http.Request) {
	index, err := strconv.Atoi(r.URL.Query().Get("index"))
	if err != nil || index < 0 {
		writeError(w, http.StatusBadRequest, "invalid_index", "index must be a non-negative integer")
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	playlist, err := account.RemoveTrackFromPlaylist(r.PathValue("id"), index)
	writePlaylistResult(w, playlist, err)
}

type reorderBody struct {
	From int `json:"from"`
	To   int `json:"to"`
}

func (s *Server) reorderPlaylist(w http.ResponseWriter, r *http.Request) {
	var body reorderBody
	if !decodeJSON(w, r, &body) || body.From < 0 || body.To < 0 {
		if body.From < 0 || body.To < 0 {
			writeError(w, http.StatusBadRequest, "invalid_index", "indexes must be non-negative")
		}
		return
	}
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	playlist, err := account.ReorderPlaylist(r.PathValue("id"), body.From, body.To)
	writePlaylistResult(w, playlist, err)
}

func (s *Server) duplicatePlaylist(w http.ResponseWriter, r *http.Request) {
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	playlist, err := account.DuplicatePlaylist(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "playlist_not_found", "playlist not found")
		return
	}
	writeJSON(w, http.StatusCreated, playlist)
}

func writePlaylistResult(w http.ResponseWriter, playlist model.Playlist, err error) {
	if err != nil {
		writeError(w, http.StatusNotFound, "playlist_not_found", "playlist not found")
		return
	}
	writeJSON(w, http.StatusOK, playlist)
}

func (s *Server) radio(w http.ResponseWriter, r *http.Request) {
	kind, id := r.PathValue("kind"), r.PathValue("id")
	if !validRadioKind(kind) || len(id) < 1 || len(id) > 200 {
		writeError(w, http.StatusBadRequest, "invalid_radio", "unsupported radio seed")
		return
	}
	if !s.searchLimit.allow(clientIP(r, s.cfg.TrustProxyHeaders)) {
		writeRateLimited(w)
		return
	}
	identity := auth.FromContext(r.Context())
	key := identity.Subject + "|" + kind + "|" + id + "|" + r.URL.RawQuery
	result, err := s.radioCache.Get(r.Context(), key, 5*time.Minute, func(ctx context.Context) (model.RadioSession, error) {
		return s.buildRadio(ctx, r, kind, id)
	})
	if err != nil {
		s.logStageFailure(r, "radio", err, "kind", kind, "seed_id", id)
		writeSearchError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) buildRadio(ctx context.Context, r *http.Request, kind, id string) (model.RadioSession, error) {
	account, err := s.account(r)
	if err != nil {
		return model.RadioSession{}, err
	}
	var seeds []model.Track
	query := ""
	switch kind {
	case "song":
		query = strings.TrimSpace(r.URL.Query().Get("artist") + " " + r.URL.Query().Get("title"))
	case "artist":
		query = r.URL.Query().Get("artist")
	case "album":
		query = strings.TrimSpace(r.URL.Query().Get("artist") + " " + r.URL.Query().Get("album"))
	case "playlist":
		for _, playlist := range account.State().Playlists {
			if playlist.ID == id {
				seeds = append(seeds, playlist.Tracks...)
				break
			}
		}
		if len(seeds) == 0 {
			return model.RadioSession{}, errors.New("playlist not found or empty")
		}
	case "liked":
		seeds = account.State().Liked
	case "library":
		seeds = account.LibraryTracks()
	}
	if query == "" && len(seeds) > 0 {
		seed := seeds[time.Now().UnixNano()%int64(len(seeds))]
		query = strings.TrimSpace(seed.Artist + " " + seed.Title)
	}
	if query == "" {
		query = id
	}
	searchResult, err := s.cachedSearch(ctx, query, "songs")
	if err != nil {
		return model.RadioSession{}, err
	}
	tracks := canonicalDedupe(append(searchResult.Songs, searchResult.Videos...), 30)
	return model.RadioSession{
		ID: fmt.Sprintf("radio_%d", time.Now().UnixNano()), Kind: kind, SeedID: id,
		Tracks: tracks, GeneratedAt: time.Now().UnixMilli(),
	}, nil
}

func (s *Server) recommendations(w http.ResponseWriter, r *http.Request) {
	identity := auth.FromContext(r.Context())
	account, err := s.account(r)
	if err != nil {
		writeInternal(w, err)
		return
	}
	state := account.State()
	fingerprint := fmt.Sprintf("%s|%d|%d", identity.Subject, len(state.History), len(state.Liked))
	result, err := s.recommendCache.Get(r.Context(), fingerprint, 10*time.Minute, func(ctx context.Context) (model.Recommendations, error) {
		return s.buildRecommendations(ctx, state)
	})
	if err != nil {
		s.logStageFailure(r, "recommendations", err)
		writeSearchError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) buildRecommendations(ctx context.Context, state model.AppState) (model.Recommendations, error) {
	seeds := make([]model.Track, 0, 4)
	seenSeed := map[string]bool{}
	for _, history := range state.History {
		if !seenSeed[history.Track.ID] {
			seeds = append(seeds, history.Track)
			seenSeed[history.Track.ID] = true
		}
		if len(seeds) == 3 {
			break
		}
	}
	for _, liked := range state.Liked {
		if !seenSeed[liked.ID] {
			seeds = append(seeds, liked)
			seenSeed[liked.ID] = true
		}
		if len(seeds) == 4 {
			break
		}
	}
	if len(seeds) == 0 {
		return model.Recommendations{Sections: []model.RecommendationSection{}, GeneratedAt: time.Now().UnixMilli()}, nil
	}
	known := map[string]bool{}
	for _, track := range state.Liked {
		known[track.ID] = true
	}
	for _, history := range state.History {
		known[history.Track.ID] = true
	}
	var sections []model.RecommendationSection
	for i, seed := range seeds {
		result, err := s.cachedSearch(ctx, strings.TrimSpace(seed.Artist+" "+seed.Title), "songs")
		if err != nil {
			if len(sections) == 0 {
				return model.Recommendations{}, err
			}
			break
		}
		candidates := make([]model.Track, 0, len(result.Songs))
		for _, track := range canonicalDedupe(result.Songs, 12) {
			if !known[track.ID] {
				candidates = append(candidates, track)
			}
		}
		if len(candidates) == 0 {
			continue
		}
		sections = append(sections, model.RecommendationSection{
			ID: fmt.Sprintf("because_%d", i), Title: "Because you listened to " + seed.Title,
			Subtitle: seed.Artist, Tracks: candidates,
		})
		if len(sections) == 3 {
			break
		}
	}
	return model.Recommendations{Sections: sections, GeneratedAt: time.Now().UnixMilli()}, nil
}

func canonicalDedupe(input []model.Track, limit int) []model.Track {
	seenID, seenTitle := map[string]bool{}, map[string]bool{}
	result := make([]model.Track, 0, minInt(limit, len(input)))
	artistCount := map[string]int{}
	for _, track := range input {
		titleKey := canonical(track.Title)
		artistKey := canonical(strings.Split(track.Artist, ",")[0])
		if track.ID == "" || seenID[track.ID] || titleKey != "" && seenTitle[titleKey] || artistCount[artistKey] >= 3 {
			continue
		}
		seenID[track.ID], seenTitle[titleKey] = true, true
		artistCount[artistKey]++
		result = append(result, track)
		if len(result) == limit {
			break
		}
	}
	if result == nil {
		return []model.Track{}
	}
	return result
}

func canonical(value string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return -1
	}, value)
}

const requestIDHeader = "X-Melo-Request-ID"

func (s *Server) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.Header.Get("X-Request-ID"))
		if !validRequestID(id) {
			var raw [12]byte
			if _, err := rand.Read(raw[:]); err != nil {
				id = fmt.Sprintf("fallback-%d", time.Now().UnixNano())
			} else {
				id = hex.EncodeToString(raw[:])
			}
		}
		r.Header.Set(requestIDHeader, id)
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r)
	})
}

func validRequestID(value string) bool {
	if len(value) < 8 || len(value) > 80 {
		return false
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '-' || char == '_') {
			return false
		}
	}
	return true
}

func requestID(r *http.Request) string { return r.Header.Get(requestIDHeader) }

func (s *Server) logStageFailure(r *http.Request, stage string, err error, attributes ...any) {
	_, failure := providerErrorStatus(err)
	fields := []any{"stage", stage, "request_id", requestID(r), "failure", failure}
	fields = append(fields, attributes...)
	s.logger.Error("provider operation failed", fields...)
}

func (s *Server) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodOptions && !s.globalLimit.allow(clientIP(r, s.cfg.TrustProxyHeaders)) {
			writeRateLimited(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) cors(next http.Handler) http.Handler {
	allowed := make(map[string]bool, len(s.cfg.CORSOrigins))
	for _, origin := range s.cfg.CORSOrigins {
		allowed[origin] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimRight(r.Header.Get("Origin"), "/")
		if origin != "" {
			if !allowed[origin] {
				writeError(w, http.StatusForbidden, "origin_denied", "origin is not allowed")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Expose-Headers", "X-Request-ID")
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Accept, Range")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if value := recover(); value != nil {
				s.logger.Error("request panic", "method", r.Method, "path", r.URL.Path, "error", value)
				writeError(w, http.StatusInternalServerError, "internal_error", "an internal error occurred")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *statusWriter) Flush()                      { _ = http.NewResponseController(w.ResponseWriter).Flush() }

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		wrapped := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(wrapped, r)
		if r.URL.Path != "/health" && !strings.Contains(r.URL.Path, "/stream/") {
			s.logger.Info("http request", "request_id", requestID(r), "method", r.Method, "path", r.URL.Path, "status", wrapped.status, "duration_ms", time.Since(started).Milliseconds())
		}
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	if contentType := r.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		writeError(w, http.StatusUnsupportedMediaType, "content_type", "Content-Type must be application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "request body is invalid")
		return false
	}
	var extra any
	if decoder.Decode(&extra) == nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "request body must contain one JSON value")
		return false
	}
	return true
}

func validateTrack(w http.ResponseWriter, track model.Track) bool {
	if len(track.ID) < 1 || len(track.ID) > 200 || !validSourceID(track.SourceID) || len(track.Title) < 1 || len(track.Title) > 500 || len(track.Artist) > 500 || len(track.URL) > 2000 || len(track.Artwork) > 2000 {
		writeError(w, http.StatusBadRequest, "invalid_track", "track fields are invalid or too long")
		return false
	}
	return true
}

func validateTracks(w http.ResponseWriter, tracks []model.Track) bool {
	if len(tracks) > 1000 {
		writeError(w, http.StatusBadRequest, "playlist_too_large", "a playlist update may contain at most 1000 tracks")
		return false
	}
	for _, track := range tracks {
		if !validateTrack(w, track) {
			return false
		}
	}
	return true
}

func validatePlaylistInput(w http.ResponseWriter, name string, tracks []model.Track) bool {
	if len(strings.TrimSpace(name)) < 1 || len(name) > 120 {
		writeError(w, http.StatusBadRequest, "invalid_playlist_name", "playlist name must be 1–120 characters")
		return false
	}
	return validateTracks(w, tracks)
}

func validSourceID(id string) bool {
	if len(id) < 3 || len(id) > 128 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func validFilter(filter string) bool {
	switch filter {
	case "", "songs", "videos", "albums", "artists", "playlists":
		return true
	}
	return false
}

func validRadioKind(kind string) bool {
	switch kind {
	case "song", "artist", "album", "playlist", "liked", "library":
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func writeInternal(w http.ResponseWriter, err error) {
	slog.Error("storage error", "error", err)
	writeError(w, http.StatusInternalServerError, "storage_error", "account storage is unavailable")
}

func providerErrorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout, "provider_timeout"
	case errors.Is(err, cache.ErrCircuitOpen):
		return http.StatusServiceUnavailable, "provider_backoff"
	case errors.Is(err, media.ErrUnavailable):
		return http.StatusNotFound, "media_unavailable"
	case errors.Is(err, media.ErrNoAudio):
		return http.StatusNotFound, "no_supported_audio"
	case errors.Is(err, media.ErrProviderNetwork):
		return http.StatusBadGateway, "provider_network"
	default:
		return http.StatusBadGateway, "provider_error"
	}
}

func writeSearchError(w http.ResponseWriter, err error) {
	status, code := providerErrorStatus(err)
	message := "Search is temporarily unavailable. Try again shortly."
	if status == http.StatusGatewayTimeout {
		message = "Search timed out. Try again."
	}
	writeError(w, status, code, message)
}

func writeResolveError(w http.ResponseWriter, err error) {
	status, code := providerErrorStatus(err)
	message := "Couldn't resolve this track. Try again."
	switch code {
	case "media_unavailable":
		message = "The playback provider reports this media as unavailable."
	case "no_supported_audio":
		message = "The provider returned no supported progressive audio format."
	case "provider_timeout":
		message = "Track resolution timed out. Try again."
	case "provider_backoff":
		message = "Playback provider is temporarily unavailable. Try again shortly."
	}
	errorBody := map[string]any{"code": code, "message": message}
	if attempts := media.ResolverAttempts(err); len(attempts) > 0 {
		errorBody["resolverAttempts"] = attempts
	}
	writeJSON(w, status, map[string]any{"error": errorBody})
}

func writeLyricsError(w http.ResponseWriter, err error) {
	status, code := providerErrorStatus(err)
	message := "Lyrics are temporarily unavailable."
	if status == http.StatusGatewayTimeout {
		message = "Lyrics request timed out. Try again."
	}
	writeError(w, status, code, message)
}

func writeRateLimited(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "30")
	writeError(w, http.StatusTooManyRequests, "rate_limited", "too many requests; retry shortly")
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
