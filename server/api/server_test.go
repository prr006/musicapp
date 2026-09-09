package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"melo/internal/lyrics"
	"melo/internal/media"
	"melo/internal/model"
	"melo/server/auth"
	"melo/server/config"
	accountstore "melo/server/store"
)

type fakeProvider struct{ calls int }

type unavailableRunner struct{}

type zeroFormatsRunner struct{}

func (unavailableRunner) Run(context.Context, ...string) ([]byte, error) {
	return nil, errors.New("ERROR: Video unavailable")
}

func (zeroFormatsRunner) Run(context.Context, ...string) ([]byte, error) {
	return []byte(`{"id":"Kx7B-XvmFtE","title":"Believer","artist":"Imagine Dragons","formats":[]}`), nil
}

func (f *fakeProvider) Search(_ context.Context, query, _ string) (model.SearchResponse, error) {
	f.calls++
	return model.SearchResponse{
		Query: query, Songs: []model.Track{{
			ID: "yt:abcdefghijk", SourceID: "abcdefghijk", Source: "youtube",
			Title: "Test Song", Artist: "Test Artist",
		}}, Provider: "test",
	}, nil
}

type fakeResolver struct{}

func (fakeResolver) Resolve(_ context.Context, id, _ string) (media.Resolved, error) {
	return media.Resolved{
		SourceID: id, URL: "https://provider.invalid/private", MimeType: "audio/mp4",
		Duration: 180, Bitrate: 128, ExpiresAt: time.Now().Add(time.Hour),
		Diagnostics: media.ResolverDiagnostics{
			Attempts: []media.ResolverAttempt{{
				Attempt: 1, Clients: "visionos,web", Outcome: "resolved", DurationMS: 12,
				Final: true, FormatCount: 3, FormatsWithURL: 2, AudioFormatsWithURL: 1,
				SupportedProgressiveAudio: 1, Protocols: []string{"https"},
			}},
			FinalOutcome: "resolved", DurationMS: 12,
		},
	}, nil
}

type fakeLyrics struct{}

func (fakeLyrics) Fetch(_ context.Context, query lyrics.Query) (lyrics.Result, error) {
	return lyrics.Result{TrackID: query.TrackID, Source: "test", Synced: true, Lines: []lyrics.Line{{Time: 0, Text: "hello"}}}, nil
}

func testHandler(t *testing.T) http.Handler {
	t.Helper()
	dataDir := t.TempDir()
	cfg := config.Config{
		DataDir: dataDir, CORSOrigins: []string{"https://melo.example.com"},
		SessionSecret:  []byte("01234567890123456789012345678901"),
		PlaybackSecret: []byte("abcdefghijklmnopqrstuvwxyzABCDEF"),
		SearchTimeout:  time.Second, ResolveTimeout: time.Second, LyricsTimeout: time.Second,
	}
	authService, err := auth.New(cfg.SessionSecret, false, dataDir)
	if err != nil {
		t.Fatal(err)
	}
	return New(Dependencies{
		Config: cfg, Auth: authService, Accounts: accountstore.NewFileRepository(dataDir),
		Provider: &fakeProvider{}, Resolver: fakeResolver{}, Lyrics: fakeLyrics{},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
}

func TestSearchSerializationAndCORS(t *testing.T) {
	handler := testHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/search?q=test", nil)
	req.Header.Set("Origin", "https://melo.example.com")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("Access-Control-Allow-Origin"); got != "https://melo.example.com" {
		t.Fatalf("unexpected CORS origin %q", got)
	}
	if res.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatal("credentials were not enabled for the approved origin")
	}
	var body map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"songs", "videos", "albums", "artists"} {
		if body[field] == nil {
			t.Fatalf("stable collection %q serialized as null", field)
		}
	}
}

func TestCORSRejectsUnapprovedOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "https://evil.example")
	res := httptest.NewRecorder()
	testHandler(t).ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", res.Code)
	}
	if res.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("an unapproved origin received an allow-origin header")
	}
}

func TestResolveErrorsDistinguishUnavailableFromUnsupportedFormats(t *testing.T) {
	tests := []struct {
		name string
		err  error
		code string
	}{
		{name: "provider unavailable", err: media.ErrUnavailable, code: "media_unavailable"},
		{name: "no supported audio", err: media.ErrNoAudio, code: "no_supported_audio"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := httptest.NewRecorder()
			writeResolveError(res, tt.err)
			if res.Code != http.StatusNotFound {
				t.Fatalf("expected 404, got %d", res.Code)
			}
			var body struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Error.Code != tt.code {
				t.Fatalf("expected %s, got %s", tt.code, body.Error.Code)
			}
		})
	}
}

func TestResolveErrorIncludesOnlySanitizedAttemptOutcomes(t *testing.T) {
	resolver := media.NewResolver(unavailableRunner{})
	_, err := resolver.Resolve(context.Background(), "Kx7B-XvmFtE", "high")
	if err == nil {
		t.Fatal("expected resolution to fail")
	}
	res := httptest.NewRecorder()
	writeResolveError(res, err)
	var body struct {
		Error struct {
			Code        string                    `json:"code"`
			Attempts    []media.ResolverAttempt   `json:"resolverAttempts"`
			Diagnostics media.ResolverDiagnostics `json:"resolverDiagnostics"`
		} `json:"error"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "media_unavailable" || len(body.Error.Attempts) != 3 ||
		body.Error.Diagnostics.FinalOutcome != "media_unavailable" {
		t.Fatalf("unexpected sanitized resolver detail: %+v", body.Error)
	}
	for _, attempt := range body.Error.Attempts {
		if attempt.Outcome != "provider_unavailable" {
			t.Fatalf("unexpected attempt outcome: %+v", attempt)
		}
	}
	if strings.Contains(res.Body.String(), "youtube.com/watch") {
		t.Fatal("resolve diagnostics exposed a provider URL")
	}
}

func TestExhaustedZeroFormatRetriesReturnSanitizedUnavailable(t *testing.T) {
	resolver := media.NewResolver(zeroFormatsRunner{})
	_, err := resolver.Resolve(context.Background(), "Kx7B-XvmFtE", "high")
	if err == nil {
		t.Fatal("expected zero-format retries to be exhausted")
	}
	res := httptest.NewRecorder()
	writeResolveError(res, err)
	if res.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", res.Code, res.Body.String())
	}
	var body struct {
		Error struct {
			Code        string                    `json:"code"`
			Attempts    []media.ResolverAttempt   `json:"resolverAttempts"`
			Diagnostics media.ResolverDiagnostics `json:"resolverDiagnostics"`
		} `json:"error"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "media_unavailable" || body.Error.Diagnostics.FinalOutcome != "media_unavailable" {
		t.Fatalf("unexpected exhausted retry response: %+v", body.Error)
	}
	if !strings.Contains(res.Body.String(), "temporarily returned no media formats") {
		t.Fatalf("zero-format exhaustion was not described as transient: %s", res.Body.String())
	}
	if len(body.Error.Attempts) != 9 || len(body.Error.Diagnostics.Attempts) != 9 {
		t.Fatalf("expected nine bounded subprocess attempts, got %+v", body.Error)
	}
	for _, attempt := range body.Error.Attempts {
		if attempt.Outcome != "zero_formats" {
			t.Fatalf("unexpected attempt outcome: %+v", attempt)
		}
	}
	for _, forbidden := range []string{"youtube.com/watch", "signature", "cookie", "token"} {
		if strings.Contains(strings.ToLower(res.Body.String()), forbidden) {
			t.Fatalf("resolver diagnostics exposed forbidden data %q: %s", forbidden, res.Body.String())
		}
	}
}

func TestResolveReturnsTicketNotProviderURL(t *testing.T) {
	track := `{"id":"yt:abcdefghijk","sourceId":"abcdefghijk","source":"youtube","url":"https://youtube.com/watch?v=abcdefghijk","title":"Song","artist":"Artist","album":"","artwork":"","duration":180,"explicit":false}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/resolve", strings.NewReader(track))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	testHandler(t).ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", res.Code, res.Body.String())
	}
	if strings.Contains(res.Body.String(), "provider.invalid") {
		t.Fatal("upstream provider URL leaked to the browser")
	}
	if !strings.Contains(res.Body.String(), "/api/v1/stream/abcdefghijk?") {
		t.Fatalf("missing signed playback URL: %s", res.Body.String())
	}
	var body struct {
		Diagnostics media.ResolverDiagnostics `json:"resolverDiagnostics"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Diagnostics.FinalOutcome != "resolved" || len(body.Diagnostics.Attempts) != 1 ||
		body.Diagnostics.Attempts[0].Outcome != "resolved" {
		t.Fatalf("missing sanitized success diagnostics: %+v", body.Diagnostics)
	}
}

func TestPlaybackDiagnosticsAreSanitizedAndCorrelated(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/events/playback-error", strings.NewReader(`{"trackId":"yt:abcdefghijk","code":"media_recovery_exhausted","recoverable":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Request-ID", "browser-request-123")
	res := httptest.NewRecorder()
	testHandler(t).ServeHTTP(res, req)
	if res.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d: %s", res.Code, res.Body.String())
	}
	if got := res.Header().Get("X-Request-ID"); got != "browser-request-123" {
		t.Fatalf("request id was not preserved, got %q", got)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/events/playback-error", strings.NewReader(`{"trackId":"yt:abcdefghijk","code":"raw secret text!","recoverable":false}`))
	req.Header.Set("Content-Type", "application/json")
	res = httptest.NewRecorder()
	testHandler(t).ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("unsafe diagnostic code should be rejected, got %d", res.Code)
	}
}

func TestRequestValidation(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/search?q=", nil)
	res := httptest.NewRecorder()
	testHandler(t).ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", res.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/resolve", strings.NewReader(`{"sourceId":"../../etc/passwd"}`))
	req.Header.Set("Content-Type", "application/json")
	res = httptest.NewRecorder()
	testHandler(t).ServeHTTP(res, req)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("unsafe id should be rejected, got %d", res.Code)
	}
}

func TestPlaylistOwnershipIsAccountScoped(t *testing.T) {
	server := httptest.NewServer(testHandler(t))
	defer server.Close()
	newClient := func() *http.Client {
		jar, _ := cookiejar.New(nil)
		return &http.Client{Jar: jar}
	}
	owner, stranger := newClient(), newClient()
	create, _ := http.NewRequest(http.MethodPost, server.URL+"/api/v1/playlists", strings.NewReader(`{"name":"Private","tracks":[]}`))
	create.Header.Set("Content-Type", "application/json")
	response, err := owner.Do(create)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("create failed: %d %s", response.StatusCode, body)
	}
	var playlist model.Playlist
	if err := json.NewDecoder(response.Body).Decode(&playlist); err != nil {
		t.Fatal(err)
	}

	request, _ := http.NewRequest(http.MethodDelete, server.URL+"/api/v1/playlists/"+playlist.ID, nil)
	otherResponse, err := stranger.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer otherResponse.Body.Close()
	if otherResponse.StatusCode != http.StatusNotFound {
		t.Fatalf("another account modified an owned playlist: %d", otherResponse.StatusCode)
	}
}

func TestAuthenticationBoundary(t *testing.T) {
	server := httptest.NewServer(testHandler(t))
	defer server.Close()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	register, _ := http.NewRequest(http.MethodPost, server.URL+"/api/v1/auth/register", strings.NewReader(`{"username":"listener","password":"safe-password"}`))
	register.Header.Set("Content-Type", "application/json")
	response, err := client.Do(register)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("registration failed with %d", response.StatusCode)
	}
	me, err := client.Get(server.URL + "/api/v1/me")
	if err != nil {
		t.Fatal(err)
	}
	defer me.Body.Close()
	var identity auth.Identity
	if err := json.NewDecoder(me.Body).Decode(&identity); err != nil {
		t.Fatal(err)
	}
	if !identity.Authenticated || identity.Username != "listener" {
		t.Fatalf("session did not cross the auth boundary: %+v", identity)
	}
}
