// playbench measures MELO's real click-to-play resolution path against the
// live network. It answers, with numbers on THIS machine:
//
//   - how much of a cold resolve is yt-dlp spawn/interpreter cost
//     (the --version probe) vs extraction/network (the delta)
//   - cold vs repeated resolution, cache-hit cost, and failure/retry behavior
//   - whether candidate extractor arguments (-extra) actually help, run
//     through the SAME resolver pipeline the app uses
//
// Typical run (from the repo root, with the app's managed binary or any build):
//
//	go run ./tools/playbench -ids Ian0Ts-HYYI,SelDE_98w4A -n 3
//	go run ./tools/playbench -ids Ian0Ts-HYYI -extra "--extractor-args youtube:player_skip=webpage"
//
// All output is local timing data only; no credentials are involved.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"melo/internal/deps"
	"melo/internal/media"
	"melo/internal/provider"
)

func main() {
	ids := flag.String("ids", "", "comma-separated video ids to resolve (required)")
	n := flag.Int("n", 3, "cold attempts per id")
	quality := flag.String("quality", "high", "quality tier: high|medium|low")
	bin := flag.String("bin", "", "yt-dlp executable (default: MELO_YTDLP, else the managed install)")
	extra := flag.String("extra", "", "extra yt-dlp args appended for A/B comparison (candidate flags)")
	probes := flag.Int("probe", 5, "spawn probes (--version runs); 0 disables")
	flag.Parse()

	list := splitIDs(*ids)
	if len(list) == 0 {
		fmt.Fprintln(os.Stderr, "usage: playbench -ids ID1,ID2 [-n 3] [-quality high] [-bin path] [-extra args] [-probe 5]")
		os.Exit(2)
	}

	path, err := resolveBin(*bin)
	if err != nil {
		fatal(err)
	}
	out, err := exec.Command(path, "--version").Output()
	if err != nil {
		fatal(fmt.Errorf("cannot execute %s: %w", path, err))
	}
	fmt.Printf("binary   : %s (yt-dlp %s)\n", path, strings.TrimSpace(string(out)))
	fmt.Printf("quality  : %s   ids: %s   cold attempts: %d\n", *quality, strings.Join(list, ","), *n)
	if *extra != "" {
		fmt.Printf("extra    : %s\n", *extra)
	}
	fmt.Println()

	// 1) Spawn cost: interpreter start + yt-dlp import, no network, no
	// extraction. This is the part process reuse or a faster-starting build
	// could remove; everything beyond it is extraction/network.
	if *probes > 0 {
		var times []time.Duration
		for i := 0; i < *probes; i++ {
			t0 := time.Now()
			if err := exec.Command(path, "--version").Run(); err != nil {
				fatal(err)
			}
			times = append(times, time.Since(t0))
		}
		sorted := append([]time.Duration(nil), times...)
		sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
		fmt.Printf("SPAWN PROBE  --version        median=%s  min=%s  max=%s  (n=%d)\n",
			median(sorted), sorted[0], sorted[len(sorted)-1], len(times))
	}

	runner := func() media.Runner {
		return provider.Exec{Path: func() (string, error) { return path, nil }}
	}

	// 2) Per-id: cold (fresh resolver = empty cache), warm repeat, cache hit.
	for _, id := range list {
		var cold []time.Duration
		var coldURL string
		for i := 0; i < *n; i++ {
			res := media.NewResolver(runner())
			res.ExtraArgs = extraArgs(*extra)
			t0 := time.Now()
			r, err := res.Resolve(context.Background(), id, *quality)
			cold = append(cold, time.Since(t0))
			if err != nil {
				fmt.Printf("ID %s  cold#%d  ERROR after %s: %v\n", id, i+1, cold[len(cold)-1].Round(time.Millisecond), err)
				continue
			}
			coldURL = shortURL(r.URL)
		}
		if len(cold) == 0 {
			continue
		}
		fmt.Printf("ID %s  COLD   %s  median=%s  min=%s  max=%s  url=%s\n", id,
			strings.Repeat("·", maxInt(0, 6-len(id))), dur(cold), minDur(cold), maxDur(cold), coldURL)

		// One long-lived resolver: network resolve, then the expired-URL
		// refresh path (invalidate = exactly what a 403 mid-track does), then
		// a pure in-memory cache hit.
		res := media.NewResolver(runner())
		res.ExtraArgs = extraArgs(*extra)
		t0 := time.Now()
		if _, err := res.Resolve(context.Background(), id, *quality); err != nil {
			fmt.Printf("ID %s  warm   ERROR: %v\n", id, err)
			continue
		}
		first := time.Since(t0)
		res.Invalidate(id)
		t1 := time.Now()
		if _, err := res.Resolve(context.Background(), id, *quality); err != nil {
			fmt.Printf("ID %s  repeat ERROR: %v\n", id, err)
			continue
		}
		repeat := time.Since(t1)
		t2 := time.Now()
		if _, err := res.Resolve(context.Background(), id, *quality); err != nil {
			fmt.Printf("ID %s  cache  ERROR: %v\n", id, err)
			continue
		}
		fmt.Printf("ID %s  FIRST  %s  %s   (warm resolver, network)\n", id, "······", first.Round(time.Millisecond))
		fmt.Printf("ID %s  REPEAT %s  %s   (after expiry invalidation = transparent refresh)\n", id, "······", repeat.Round(time.Millisecond))
		fmt.Printf("ID %s  CACHE  %s  %s\n", id, "······", time.Since(t2).Round(time.Microsecond))
	}

	// 3) Failure path: an invalid id must fail fast with the real error.
	res := media.NewResolver(runner())
	res.ExtraArgs = extraArgs(*extra)
	t0 := time.Now()
	_, err = res.Resolve(context.Background(), "zzzzZZZZzzz", *quality)
	if err != nil {
		fmt.Printf("FAILURE bogus id            %s  err=%s\n", time.Since(t0).Round(time.Millisecond), firstLine(err.Error()))
	} else {
		fmt.Printf("FAILURE bogus id            %s  err=none (this resolver accepted the id; use a real binary against the network)\n", time.Since(t0).Round(time.Millisecond))
	}
	fmt.Println("\nlegend: COLD = fresh resolver (no cache) · REPEAT = second resolution after a successful one ·")
	fmt.Println("        CACHE = in-memory hit · SPAWN PROBE = process start + import cost (no network)")
}

func resolveBin(flagBin string) (string, error) {
	if flagBin != "" {
		return flagBin, nil
	}
	if env := strings.TrimSpace(os.Getenv("MELO_YTDLP")); env != "" {
		return env, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	m, err := deps.NewManager(filepath.Join(base, "MELO", "bin"))
	if err != nil {
		return "", err
	}
	p, err := m.Ensure(nil)
	if err != nil {
		return "", fmt.Errorf("managed yt-dlp unavailable (pass -bin or set MELO_YTDLP): %w", err)
	}
	return p, nil
}

func extraArgs(flagValue string) []string {
	return strings.Fields(flagValue)
}

func splitIDs(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func dur(list []time.Duration) time.Duration {
	sorted := append([]time.Duration(nil), list...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	return median(sorted)
}

func median(sorted []time.Duration) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[len(sorted)/2]
}

func minDur(list []time.Duration) time.Duration {
	m := list[0]
	for _, d := range list {
		if d < m {
			m = d
		}
	}
	return m
}

func maxDur(list []time.Duration) time.Duration {
	m := list[0]
	for _, d := range list {
		if d > m {
			m = d
		}
	}
	return m
}

func shortURL(raw string) string {
	if len(raw) > 48 {
		return raw[:48] + "…"
	}
	return raw
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i > 0 {
		return s[:i]
	}
	return s
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "playbench:", err)
	os.Exit(1)
}
