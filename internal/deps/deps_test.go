package deps

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseSums(t *testing.T) {
	body := "aaaa  yt-dlp\nbbbb  yt-dlp.exe\ncccc *yt-dlp_linux\nignored line\n"
	got, err := ParseSums(body, "yt-dlp.exe")
	if err != nil || got != "bbbb" {
		t.Fatalf("got %q %v", got, err)
	}
	if got, err := ParseSums(body, "yt-dlp_linux"); err != nil || got != "cccc" {
		t.Fatalf("star-prefixed entries must parse: %q %v", got, err)
	}
	if _, err := ParseSums(body, "missing"); err == nil {
		t.Fatal("expected an error for an unlisted asset")
	}
}

func TestManifestCoversTargetPlatforms(t *testing.T) {
	m, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"windows/amd64", "windows/arm64", "linux/amd64", "darwin/arm64"} {
		if _, ok := m.manifest.Assets[key]; !ok {
			t.Errorf("manifest is missing %s", key)
		}
	}
	if m.Version() == "" || m.manifest.BaseURL == "" {
		t.Fatal("dependency must be pinned to a version and source")
	}
}

// fakeRelease serves a pinned "release" so Ensure can be tested end to end.
func fakeRelease(t *testing.T, content []byte, sumOverride string) *httptest.Server {
	t.Helper()
	sum := sha256.Sum256(content)
	digest := hex.EncodeToString(sum[:])
	if sumOverride != "" {
		digest = sumOverride
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "SHA2-256SUMS"):
			for _, name := range []string{"yt-dlp.exe", "yt-dlp_linux", "yt-dlp_macos", "yt-dlp_arm64.exe", "yt-dlp_linux_aarch64"} {
				fmt.Fprintf(w, "%s  %s\n", digest, name)
			}
		default:
			_, _ = w.Write(content)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestEnsureDownloadsVerifiesAndIsIdempotent(t *testing.T) {
	if runtime.GOOS == "js" {
		t.Skip()
	}
	dir := t.TempDir()
	m, err := NewManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("#!/bin/sh\necho 2026.08.19\n")
	srv := fakeRelease(t, content, "")
	m.manifest.BaseURL = srv.URL

	var progressSeen bool
	path, err := m.Ensure(func(done, total int64) { progressSeen = true })
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if filepath.Dir(path) != dir {
		t.Fatalf("binary installed outside the managed dir: %s", path)
	}
	if !strings.Contains(filepath.Base(path), m.Version()) {
		t.Fatalf("install path must be version-scoped: %s", path)
	}
	if !progressSeen {
		t.Error("expected progress callbacks")
	}
	if st := m.Status(); !st.Installed {
		t.Fatalf("status should report installed: %+v", st)
	}
	// Second call must not re-download.
	if _, err := m.Ensure(nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".download"); !os.IsNotExist(err) {
		t.Fatal("temp download file should not linger")
	}
}

func TestEnsureRejectsCorruptDownload(t *testing.T) {
	dir := t.TempDir()
	m, _ := NewManager(dir)
	srv := fakeRelease(t, []byte("payload"), strings.Repeat("0", 64))
	m.manifest.BaseURL = srv.URL

	if _, err := m.Ensure(nil); err == nil || !strings.Contains(err.Error(), "integrity check failed") {
		t.Fatalf("expected an integrity failure, got %v", err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".download") {
			continue
		}
		t.Fatalf("failed download left behind: %s", e.Name())
	}
}

func TestEnsureUsesPinnedDigestWhenPresent(t *testing.T) {
	dir := t.TempDir()
	m, _ := NewManager(dir)
	content := []byte("binary")
	sum := sha256.Sum256(content)
	key := runtime.GOOS + "/" + runtime.GOARCH
	asset := m.manifest.Assets[key]
	asset.SHA256 = hex.EncodeToString(sum[:])
	m.manifest.Assets[key] = asset

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "SHA2-256SUMS") {
			t.Error("pinned digests must not trigger a checksum fetch")
		}
		_, _ = w.Write(content)
	}))
	defer srv.Close()
	m.manifest.BaseURL = srv.URL
	if _, err := m.Ensure(nil); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureReportsUnreachableServer(t *testing.T) {
	m, _ := NewManager(t.TempDir())
	m.manifest.BaseURL = "http://127.0.0.1:1"
	_, err := m.Ensure(nil)
	if err == nil || !strings.Contains(err.Error(), "couldn't reach") {
		t.Fatalf("expected an actionable network error, got %v", err)
	}
}

func TestOverrideBinary(t *testing.T) {
	t.Setenv("MELO_YTDLP", "/opt/custom/yt-dlp")
	m, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p, err := m.BinaryPath()
	if err != nil || p != "/opt/custom/yt-dlp" {
		t.Fatalf("override ignored: %q %v", p, err)
	}
}
