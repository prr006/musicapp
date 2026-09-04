// Command radiodiag replays MELO's radio candidate pipeline against the live
// YouTube Music endpoints for one seed and prints the complete evidence the
// "song radio looks like artist radio" diagnosis needs:
//
//   - the seed's raw metadata (video ID, title, artist + WHERE the artist
//     value came from, uploader/channel, album) as MELO parsed it from search;
//   - every recommendation source fetched SEPARATELY (videoId /next surfaces,
//     automix continuation, RDAMVM song radio, yt-dlp RD mix), each with
//     candidate count, unique artists, unique uploaders, the artist
//     distribution, and a verdict: artist-heavy or genuinely mixed;
//   - every candidate row with title / artist (and its provenance) /
//     uploader / renderer / source endpoint / position;
//   - the stage order the production Related() call would select.
//
// Usage (run on a machine with normal YouTube access — the endpoints are
// unreachable from offline sandboxes):
//
//	go run ./tools/radiodiag <videoId>
//	go run ./tools/radiodiag "<search query>"   # first song result is the seed
//
// Example:
//
//	go run ./tools/radiodiag "Killers From The Northside Kordhell"
package main

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"sort"
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
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	client := provider.New(provider.Exec{Path: func() (string, error) {
		return "", fmt.Errorf("yt-dlp not wired into radiodiag (InnerTube surfaces only)")
	}})

	// ---- seed: raw metadata exactly as MELO's search parser produced it ----
	seed := model.Track{SourceID: arg, Title: arg}
	if !videoIDRe.MatchString(arg) {
		res, err := client.Search(ctx, arg, "songs")
		if err != nil {
			fatal("search %q: %v", arg, err)
		}
		candidates := res.Songs
		if len(candidates) == 0 {
			candidates = res.Videos
		}
		if len(candidates) == 0 {
			fatal("no results for %q", arg)
		}
		seed = candidates[0]
	}

	fmt.Println("================ SEED (as MELO parsed it from search) ================")
	fmt.Printf("videoID        %s\n", seed.SourceID)
	fmt.Printf("title          %q\n", seed.Title)
	fmt.Printf("artist         %q\n", seed.Artist)
	fmt.Printf("artistSource   %s\n", artistSrcLabel(seed.ArtistSrc))
	fmt.Printf("uploader       %q\n", seed.Uploader)
	fmt.Printf("album          %q\n", seed.Album)
	fmt.Printf("renderer/endpoint (via) %s\n", seed.Via)
	fmt.Println()

	// ---- every source, fetched separately ----
	stages, err := client.DiagnoseRelated(ctx, seed.SourceID)
	if err != nil {
		fatal("diagnose related for %s: %v", seed.SourceID, err)
	}
	if len(stages) == 0 {
		fmt.Println("NO SOURCE ANSWERED — the production code would fall back to")
		fmt.Println("identity-verified artist search (and label the radio accordingly).")
		return
	}

	for i, st := range stages {
		fmt.Printf("================ SOURCE %d: %s ================\n", i+1, st.Kind)
		fmt.Printf("endpoint: %s\n", st.Endpoint)
		printStats(st.Tracks)
		printTable(st.Tracks)
		fmt.Println()
	}

	// ---- what production would do with these stages ----
	selected := provider.SelectRadioStages(stages)
	fmt.Println("================ PRODUCTION SELECTION ================")
	fmt.Printf("stage order: ")
	for i, st := range selected {
		mark := ""
		if st.Kind != stages[i].Kind {
			mark = "  <-- promoted (previous lead was artist-heavy)"
		}
		fmt.Printf("%s(%d)%s ", st.Kind, len(st.Tracks), mark)
	}
	fmt.Println()
	merged := flatten(selected)
	printStats(merged)
	fmt.Println()
	fmt.Println("Run the app with MELO_RADIO_DEBUG=1 to see the same provenance for live requests.")
}

func printStats(tracks []model.Track) {
	fmt.Printf("candidates: %d\n", len(tracks))
	artists := map[string]int{}
	uploaders := map[string]int{}
	identified := 0
	for _, t := range tracks {
		if t.Artist != "" {
			artists[strings.ToLower(t.Artist)]++
			identified++
		}
		if t.Uploader != "" {
			uploaders[strings.ToLower(t.Uploader)]++
		}
	}
	fmt.Printf("unique artists: %d   unique uploaders: %d   rows with real artist metadata: %d/%d\n",
		len(artists), len(uploaders), identified, len(tracks))
	type kv struct {
		key string
		n   int
	}
	var dist []kv
	for k, n := range artists {
		dist = append(dist, kv{k, n})
	}
	sort.Slice(dist, func(i, j int) bool { return dist[i].n > dist[j].n })
	limit := 8
	if len(dist) < limit {
		limit = len(dist)
	}
	for i := 0; i < limit; i++ {
		fmt.Printf("  artist %-28s %2d rows (%.0f%%)\n", dist[i].key, dist[i].n,
			100*float64(dist[i].n)/float64(len(tracks)))
	}
	top := 0
	if len(dist) > 0 {
		top = dist[0].n
	}
	verdict := "GENUINELY MIXED (recommendation-oriented)"
	if len(tracks) >= 6 && float64(top)/float64(len(tracks)) >= 0.6 {
		verdict = "ARTIST-HEAVY (must NOT define a Song Radio on its own)"
	}
	fmt.Printf("verdict:     %s\n", verdict)
}

func printTable(tracks []model.Track) {
	fmt.Printf("%4s  %-38s %-26s %-22s %-34s %s\n", "pos", "title", "artist (src)", "uploader", "renderer", "videoId")
	for i, t := range tracks {
		artist := t.Artist
		if artist == "" {
			artist = "—"
		}
		artist = fmt.Sprintf("%s (%s)", clamp(artist, 18), artistSrcLabel(t.ArtistSrc))
		uploader := t.Uploader
		if uploader == "" {
			uploader = "—"
		}
		fmt.Printf("%4d  %-38s %-26s %-22s %-34s %s\n",
			i+1, clamp(t.Title, 38), artist, clamp(uploader, 22), t.Via, t.SourceID)
	}
}

func flatten(stages []provider.RadioStage) []model.Track {
	out := []model.Track{}
	seen := map[string]bool{}
	for _, st := range stages {
		for _, t := range st.Tracks {
			if !seen[t.SourceID] {
				seen[t.SourceID] = true
				out = append(out, t)
			}
		}
	}
	return out
}

func artistSrcLabel(src string) string {
	switch src {
	case "browse":
		return "music-browse" // provider explicitly identified the artist
	case "topic":
		return "topic-channel" // official "<Artist> - Topic" promotion
	case "metadata":
		return "yt-dlp-metadata"
	case "":
		return "NONE(uploader-only)"
	default:
		return src
	}
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
