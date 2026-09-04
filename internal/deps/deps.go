// Package deps manages external executables the app needs at runtime
// (currently only yt-dlp). Dependencies are version-pinned, integrity-checked
// and installed into the user data directory — never taken from PATH, and
// never written inside the source tree (which would trip dev watchers).
package deps

import (
	"archive/zip"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed manifest.json
var manifestRaw []byte

type Asset struct {
	Name   string `json:"name"`   // release asset file name
	SHA256 string `json:"sha256"` // pinned digest; empty => verified via release SHA2-256SUMS
	// Entry is the executable's path inside a .zip asset (the onedir builds
	// ship yt-dlp.exe plus an _internal/ tree at the archive root). Empty for
	// single-file assets.
	Entry string `json:"entry"`
}

// zipped reports whether this asset is a directory-style zip (yt-dlp's onedir
// builds) rather than a single executable file.
func (a Asset) zipped() bool { return strings.EqualFold(filepath.Ext(a.Name), ".zip") }

type Manifest struct {
	Tool      string           `json:"tool"`
	Version   string           `json:"version"`
	BaseURL   string           `json:"baseUrl"`
	SumsAsset string           `json:"sumsAsset"`
	Assets    map[string]Asset `json:"assets"` // key: GOOS/GOARCH
}

type Status struct {
	Installed bool   `json:"installed"`
	Path      string `json:"path"`
	Version   string `json:"version"`
	Message   string `json:"message"`
}

var ErrUnsupportedPlatform = errors.New("no managed yt-dlp build for this platform")

type Manager struct {
	dir      string
	manifest Manifest
	mu       sync.Mutex
	client   *http.Client

	// override lets tests and power users point at an existing binary.
	override string
}

func NewManager(dir string) (*Manager, error) {
	var m Manifest
	if err := json.Unmarshal(manifestRaw, &m); err != nil {
		return nil, fmt.Errorf("bad dependency manifest: %w", err)
	}
	return &Manager{
		dir:      dir,
		manifest: m,
		client:   &http.Client{Timeout: 10 * time.Minute},
		override: strings.TrimSpace(os.Getenv("MELO_YTDLP")),
	}, nil
}

func (m *Manager) Version() string { return m.manifest.Version }

func (m *Manager) platformKey() string { return runtime.GOOS + "/" + runtime.GOARCH }

// BinaryPath is the deterministic install location, versioned so an upgrade
// never races a running process. Zip (onedir) assets install into a versioned
// DIRECTORY and the path points at the executable inside it; single-file
// assets install as one versioned file.
func (m *Manager) BinaryPath() (string, error) {
	if m.override != "" {
		return m.override, nil
	}
	asset, ok := m.manifest.Assets[m.platformKey()]
	if !ok {
		return "", ErrUnsupportedPlatform
	}
	if asset.zipped() {
		dir := fmt.Sprintf("yt-dlp-%s", m.manifest.Version)
		entry := asset.Entry
		if entry == "" {
			entry = "yt-dlp.exe"
		}
		return filepath.Join(m.dir, dir, filepath.FromSlash(entry)), nil
	}
	name := fmt.Sprintf("yt-dlp-%s", m.manifest.Version)
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(m.dir, name), nil
}

// legacyPath is the pre-zip install location of the Windows onefile build.
// It is removed after a successful onedir install so upgrades don't leave two
// copies of the tool behind.
func (m *Manager) legacyPath() string {
	return filepath.Join(m.dir, fmt.Sprintf("yt-dlp-%s.exe", m.manifest.Version))
}

func (m *Manager) Status() Status {
	p, err := m.BinaryPath()
	if err != nil {
		return Status{Message: err.Error()}
	}
	if fi, err := os.Stat(p); err == nil && fi.Size() > 0 {
		return Status{Installed: true, Path: p, Version: m.manifest.Version}
	}
	return Status{Path: p, Version: m.manifest.Version, Message: "not installed"}
}

// Ensure installs the pinned binary if missing and returns its path.
// Concurrent callers are serialised; the download is atomic (temp + rename).
func (m *Manager) Ensure(progress func(done, total int64)) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	p, err := m.BinaryPath()
	if err != nil {
		return "", err
	}
	if fi, err := os.Stat(p); err == nil && fi.Size() > 0 {
		return p, nil
	}
	if m.override != "" {
		return "", fmt.Errorf("MELO_YTDLP points at %s but it does not exist", m.override)
	}
	asset := m.manifest.Assets[m.platformKey()]
	if err := os.MkdirAll(m.dir, 0o755); err != nil {
		return "", err
	}

	want := strings.ToLower(strings.TrimSpace(asset.SHA256))
	if want == "" {
		want, err = m.fetchPinnedSum(asset.Name)
		if err != nil {
			return "", err
		}
	}

	url := fmt.Sprintf("%s/%s/%s", strings.TrimRight(m.manifest.BaseURL, "/"), m.manifest.Version, asset.Name)
	tmp := p + ".download"
	if asset.zipped() {
		// The final path sits inside a directory that does not exist yet;
		// stage the archive in the managed dir root instead.
		tmp = filepath.Join(m.dir, fmt.Sprintf(".yt-dlp-%s.zip.download", m.manifest.Version))
	}
	if err := m.download(url, tmp, progress); err != nil {
		os.Remove(tmp)
		return "", err
	}
	sum, err := fileSHA256(tmp)
	if err != nil {
		os.Remove(tmp)
		return "", err
	}
	if sum != want {
		os.Remove(tmp)
		return "", fmt.Errorf("integrity check failed for %s: expected %s, got %s", asset.Name, want, sum)
	}

	if asset.zipped() {
		// Onedir builds: extract the verified archive into a temp directory,
		// locate the entry executable, then swap the whole directory into its
		// versioned home in one rename. A crash mid-way never leaves a
		// half-written install visible under the final path.
		staging := filepath.Join(m.dir, fmt.Sprintf(".yt-dlp-%s.staging", m.manifest.Version))
		os.RemoveAll(staging)
		if err := unzip(tmp, staging); err != nil {
			os.Remove(tmp)
			os.RemoveAll(staging)
			return "", err
		}
		entryDir, err := locateEntry(staging, asset.entryName())
		if err != nil {
			os.Remove(tmp)
			os.RemoveAll(staging)
			return "", err
		}
		finalDir := filepath.Dir(p)
		if err := os.RemoveAll(finalDir); err != nil {
			os.Remove(tmp)
			os.RemoveAll(staging)
			return "", err
		}
		if err := os.Rename(entryDir, finalDir); err != nil {
			os.Remove(tmp)
			os.RemoveAll(staging)
			return "", err
		}
		os.Remove(tmp)
		os.RemoveAll(staging)
		// Best-effort cleanup of the pre-zip onefile install.
		os.Remove(m.legacyPath())
		return p, nil
	}

	if err := os.Chmod(tmp, 0o755); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, p); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return p, nil
}

// entryName is the executable file name inside a zip asset.
func (a Asset) entryName() string {
	if a.Entry == "" {
		return "yt-dlp.exe"
	}
	return filepath.Base(filepath.FromSlash(a.Entry))
}

// locateEntry finds the directory inside staging that actually contains the
// entry executable: the onedir archives unpack yt-dlp.exe at the root, but a
// future repack that wraps everything in one folder is accepted too.
func locateEntry(staging, entry string) (string, error) {
	if _, err := os.Stat(filepath.Join(staging, entry)); err == nil {
		return staging, nil
	}
	entries, err := os.ReadDir(staging)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(staging, e.Name(), entry)); err == nil {
			return filepath.Join(staging, e.Name()), nil
		}
	}
	return "", fmt.Errorf("archive does not contain %s", entry)
}

// unzip extracts archive into dest, rejecting path-traversal entries
// (zip-slip) and preserving the modes the archive declares.
func unzip(archive, dest string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return fmt.Errorf("couldn't open the resolver archive: %w", err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		name := filepath.FromSlash(f.Name)
		if name == "" || strings.HasPrefix(name, ".."+string(filepath.Separator)) || filepath.IsAbs(name) {
			return fmt.Errorf("unsafe path in archive: %q", f.Name)
		}
		if index := strings.Index(name, ".."+string(filepath.Separator)); index >= 0 {
			return fmt.Errorf("unsafe path in archive: %q", f.Name)
		}
		target := filepath.Join(dest, name)
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		mode := f.Mode()
		if mode.Perm() == 0 {
			mode = 0o644
		}
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode.Perm())
		if err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			out.Close()
			return err
		}
		if _, err := io.Copy(out, rc); err != nil {
			rc.Close()
			out.Close()
			return err
		}
		rc.Close()
		out.Close()
	}
	return nil
}

// fetchPinnedSum reads the digest for assetName out of the pinned release's
// SHA2-256SUMS file. The release tag is still pinned, so this only trusts the
// checksum listing, never a floating "latest" build.
func (m *Manager) fetchPinnedSum(assetName string) (string, error) {
	url := fmt.Sprintf("%s/%s/%s", strings.TrimRight(m.manifest.BaseURL, "/"), m.manifest.Version, m.manifest.SumsAsset)
	resp, err := m.client.Get(url)
	if err != nil {
		return "", fmt.Errorf("couldn't reach the download server for the media resolver: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("checksum listing unavailable (HTTP %d)", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	return ParseSums(string(body), assetName)
}

// ParseSums extracts the digest of assetName from a "sha256␠␠name" listing.
func ParseSums(body, assetName string) (string, error) {
	for _, line := range strings.Split(body, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) != 2 {
			continue
		}
		if strings.TrimPrefix(fields[1], "*") == assetName {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("no checksum published for %s", assetName)
}

func (m *Manager) download(url, dest string, progress func(done, total int64)) error {
	resp, err := m.client.Get(url)
	if err != nil {
		return fmt.Errorf("couldn't download the media resolver: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("couldn't download the media resolver (HTTP %d)", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	total := resp.ContentLength
	var done int64
	buf := make([]byte, 256*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			done += int64(n)
			if progress != nil {
				progress(done, total)
			}
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// SelfCheck runs `yt-dlp --version` to confirm the binary actually executes.
func (m *Manager) SelfCheck(bin string) (string, error) {
	cmd := exec.Command(bin, "--version")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("media resolver failed to start: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}
