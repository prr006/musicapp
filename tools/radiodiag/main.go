// Command radiodiag replays MELO's full radio candidate pipeline against the
// live YouTube Music endpoints for one seed and prints every candidate with
// its provenance — the diagnostic for "why does song radio look like artist
// radio?". It answers, from real provider data, which surfaces answered
// (queue panel / automix continuation / RDAMVM song radio / yt-dlp mix), how
// many candidates each contributed, and what identity (artist vs uploader)
// was parsed for every row.
//
// Usage (needs a machine with normal YouTube access — the endpoints are
// unreachable from offline sandboxes):
//
//	go run ./tools/radiodiag <videoId>
//	go run ./tools/radiodiag "<search query>"     # first song result is the seed
//
// Example:
//
//	go run ./tools/radiodiag "LUZ ROJA Slowed bxkq"
package main

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"melo/internal/model"
	"melo/internal/provider"
)

var videoIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run ./tools/radiodiag <videoId | search query>")
		os.Exit(2)
	}
	arg := os.Args[1]
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client := provider.New(provider.Exec{Path: func() (string, error) {
		return "", fmt.Errorf("yt-dlp not wired into radiodiag; InnerTube surfaces only")
	}})

	seed := arg
	if !videoIDRe.MatchString(arg) {
		res, err := client.Search(ctx, arg, "songs")
		if err != nil {
			fatal("search %q: %v", arg, err)
		}
		if len(res.Songs) == 0 {
			fatal("no song results for %q", arg)
		}
		seed = res.Songs[0].SourceID
		fmt.Printf("seed resolved via search: %s — %s — %s (uploader: %s)\n\n",
			res.Songs[0].Title, res.Songs[0].Artist, seed, res.Songs[0].Uploader)
	}

	res, err := client.Related(ctx, seed)
	if err != nil {
		fatal("related for %s: %v", seed, err)
	}

	fmt.Printf("pipeline source: %s\n", res.Source)
	if len(res.Shelves) == 0 {
		fmt.Println("shelves: (none — the response contributed no candidates)")
	}
	for _, sh := range res.Shelves {
		fmt.Printf("  %-15s %d candidates\n", sh.Kind, sh.Count)
	}
	fmt.Printf("\n%d candidates (in provider order):\n", len(res.Tracks))
	fmt.Printf("%4s  %-12s %-38s %-24s %-24s %s\n", "rank", "videoId", "title", "artist", "uploader", "dur")
	for i, t := range res.Tracks {
		artist := t.Artist
		if artist == "" {
			artist = "—"
		}
		uploader := t.Uploader
		if uploader == "" {
			uploader = "—"
		}
		title := t.Title
		if len(title) > 36 {
			title = title[:36] + "…"
		}
		fmt.Printf("%4d  %-12s %-38s %-24s %-24s %s\n",
			i+1, t.SourceID, title, clamp(artist, 24), clamp(uploader, 24), clock(t.Duration))
	}

	// The headline question: is this feed one artist?
	if n := dominantShare(res.Tracks); n >= 0.6 && len(res.Tracks) >= 6 {
		fmt.Printf("\n⚠ this feed is %.0f%% one artist identity — artistDominated=true\n", n*100)
	} else {
		fmt.Printf("\n✓ feed identity share: max %.0f%%\n", n*100)
	}
}

// dominantShare is the largest fraction of the feed held by one artist (or,
// when no artist is identified, uploader) identity.
func dominantShare(tracks []model.Track) float64 {
	if len(tracks) == 0 {
		return 0
	}
	counts := map[string]int{}
	for _, t := range tracks {
		id := strings.ToLower(strings.TrimSpace(t.Artist))
		if id == "" {
			id = strings.ToLower(strings.TrimSpace(t.Uploader))
		}
		if id != "" {
			counts[id]++
		}
	}
	top := 0
	for _, n := range counts {
		if n > top {
			top = n
		}
	}
	return float64(top) / float64(len(tracks))
}

func clock(secs float64) string {
	if secs <= 0 {
		return "—"
	}
	m := int(secs) / 60
	s := int(secs) % 60
	return fmt.Sprintf("%d:%02d", m, s)
}

func clamp(s string, n int) string {
	if len(s) > n {
		return s[:n-1] + "…"
	}
	return s
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "radiodiag: "+format+"\n", args...)
	os.Exit(1)
}
