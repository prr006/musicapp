// Command pindeps refreshes internal/deps/manifest.json with the SHA-256
// digests published for the pinned yt-dlp release. Run it whenever the pinned
// version changes; commit the result so end-user installs are fully
// deterministic and verified against a digest that lives in source control.
//
//	go run ./tools/pindeps            # re-pin the version already in the manifest
//	go run ./tools/pindeps 2026.08.19 # pin a specific release
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const manifestPath = "internal/deps/manifest.json"

type asset struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}

type manifest struct {
	Tool      string           `json:"tool"`
	Version   string           `json:"version"`
	BaseURL   string           `json:"baseUrl"`
	SumsAsset string           `json:"sumsAsset"`
	Assets    map[string]asset `json:"assets"`
}

func main() {
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		fail(err)
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		fail(err)
	}
	if len(os.Args) > 1 {
		m.Version = os.Args[1]
	}

	url := fmt.Sprintf("%s/%s/%s", strings.TrimRight(m.BaseURL, "/"), m.Version, m.SumsAsset)
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		fail(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fail(fmt.Errorf("%s returned HTTP %d", url, resp.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		fail(err)
	}

	sums := map[string]string{}
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		sums[strings.TrimPrefix(fields[1], "*")] = strings.ToLower(fields[0])
	}

	for key, a := range m.Assets {
		digest, ok := sums[a.Name]
		if !ok {
			fail(fmt.Errorf("release %s publishes no checksum for %s (%s)", m.Version, a.Name, key))
		}
		a.SHA256 = digest
		m.Assets[key] = a
		fmt.Printf("%-14s %-22s %s\n", key, a.Name, digest)
	}

	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile(manifestPath, append(out, '\n'), 0o644); err != nil {
		fail(err)
	}
	fmt.Printf("\npinned %s %s in %s\n", m.Tool, m.Version, manifestPath)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "pindeps:", err)
	os.Exit(1)
}
