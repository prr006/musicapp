// Command radiodiag is the real-data diagnostic for MELO's radio pipeline.
// Run it on a machine with normal YouTube access (the endpoints are
// unreachable from offline sandboxes).
//
//	go run ./tools/radiodiag K5v9A-uye6I              # exact video ID, NO search
//	go run ./tools/radiodiag "Killers From The Northside"  # search listing first
//
// For a video ID it fetches EVERY recommendation source separately — the four
// /next surfaces, the automix preview continuation (reported even when the
// preview is absent), continuationItemRenderer continuations, the RDAMVM
// song-radio playlist and the yt-dlp RD mix (when a yt-dlp binary is
// available) — never stopping at the first non-empty queue, and prints a
// section per source even when it contributes 0 candidates. It also prints
// the seed's raw metadata (with the exact origin of the Artist value and all
// browse ids) and the point where the production ladder would have stopped.
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	client := provider.New(provider.Exec{Path: ytDlpPath})
	// Optional overrides (used for smoke-testing the tool without YouTube
	// access, or pointing at a proxy).
	if u := os.Getenv("MELO_RADIO_NEXT_URL"); u != "" {
		client.NextEndpoint = u
	}
	if u := os.Getenv("MELO_RADIO_SEARCH_URL"); u != "" {
		client.Endpoint = u
	}

	// ---- seed resolution ----
	if videoIDRe.MatchString(arg) {
		fmt.Printf("mode: exact video ID %s (no search performed, per diagnosis procedure)\n\n", arg)
		printAllSources(ctx, client, arg)
		return
	}

	// Query mode: show which video IDs the app's own search would surface —
	// the Windows app seeds whatever the user clicked HERE, which may well
	// differ from the ID tested above.
	res, err := client.Search(ctx, arg, "songs")
	if err != nil {
		fatal("search %q: %v", arg, err)
	}
	fmt.Printf("mode: search %q — these are the rows MELO's search shows (the app seeds whichever is clicked):\n\n", arg)
	rows := append(append([]model.Track{}, res.Songs...), res.Videos...)
	if len(rows) == 0 {
		fmt.Println("  (no results)")
		return
	}
	limit := 8
	if len(rows) < limit {
		limit = len(rows)
	}
	for i := 0; i < limit; i++ {
		t := rows[i]
		fmt.Printf("  %d. VIDEO ID:%-14s %q  ARTIST:%q(%s)  UPLOADER:%q  via=%s\n",
			i+1, t.SourceID, t.Title, t.Artist, srcLabel(t.ArtistSrc), t.Uploader, t.Via)
	}
	fmt.Println("\nre-run with any of these video IDs for the full per-source report.")
}

func printAllSources(ctx context.Context, client *provider.Client, videoID string) {
	stages, err := client.DiagnoseRelated(ctx, videoID)
	if err != nil {
		fmt.Printf("DiagnoseRelated returned an error (sections below still report what happened): %v\n\n", err)
	}

	// ---- SEED metadata: the first queue-panel row is the watch feed's echo
	// of the seed itself; its raw runs carry the channel/album browse ids.
	// (The app's seed Track comes from search — compare the two.)
	fmt.Println("================ SEED (from the /next panel echo row) ================")
	echo := model.Track{}
	for _, st := range stages {
		for _, t := range st.Tracks {
			if t.SourceID == videoID {
				echo = t
				break
			}
		}
	}
	if echo.SourceID == "" {
		fmt.Println("  no panel echo of the seed in any surface — the /next answer for this")
		fmt.Println("  video does not even list itself (its metadata must come from search).")
	}
	printSeed(echo)

	// ---- one section per source, even when it contributed nothing ----
	for i, st := range stages {
		fmt.Printf("\n================ SOURCE %d/%d: %s ================\n", i+1, len(stages), st.Kind)
		fmt.Printf("endpoint/request: %s\n", st.Endpoint)
		if st.Note != "" {
			fmt.Printf("note:            %s\n", st.Note)
		}
		printStats(st.Tracks)
		if len(st.Tracks) > 0 {
			printTable(st.Tracks)
		}
	}

	// ---- what production would have done with the same data ----
	fmt.Println("\n================ PRODUCTION PREVIEW ================")
	nonEmpty := []provider.RadioStage{}
	for _, st := range stages {
		if len(st.Tracks) > 0 {
			nonEmpty = append(nonEmpty, st)
		}
	}
	surfaces := countSurfaces(nonEmpty)
	if surfaces > 0 && !provider.NeedsBroaderSources(nonEmpty[:surfaces]) {
		fmt.Printf("the production ladder STOPS after the videoId /next answer (usable tracks: %d, not artist-dominated)\n",
			surfaces)
	} else {
		stopAt := "videoId /next surfaces"
		for i := range nonEmpty {
			stopAt = nonEmpty[i].Kind
			if !provider.NeedsBroaderSources(nonEmpty[:i+1]) {
				break
			}
		}
		fmt.Printf("the production ladder continues (feed empty or artist-heavy); last stage it would stop at: %s\n", stopAt)
	}
	selected := provider.SelectRadioStages(nonEmpty)
	fmt.Print("final stage order: ")
	for i, st := range selected {
		mark := ""
		if i < len(nonEmpty) && st.Kind != nonEmpty[i].Kind && i == 0 {
			mark = " <-- PROMOTED (previous lead was artist-heavy)"
		}
		fmt.Printf("%s(%d)%s ", st.Kind, len(st.Tracks), mark)
	}
	fmt.Println()
	fmt.Println("\nRun the app with MELO_RADIO_DEBUG=1 to log SEED/REQUEST/SOURCE/CANDIDATE provenance for live playback.")
}

// countSurfaces slices "the videoId /next surfaces" out of the stage list;
// production treats them as one ladder step.
func countSurfaces(stages []provider.RadioStage) int {
	n := 0
	for _, st := range stages {
		switch st.Kind {
		case "queue", "related-videos", "music-shelves", "tiles":
			n++
		}
	}
	return n
}

func printSeed(t model.Track) {
	fmt.Printf("video ID:            %s\n", t.SourceID)
	fmt.Printf("title:               %q\n", t.Title)
	fmt.Printf("artist:              %q\n", t.Artist)
	fmt.Printf("artistSrc:           %s\n", srcLabel(t.ArtistSrc))
	fmt.Printf("uploader:            %q\n", t.Uploader)
	fmt.Printf("uploader/channel ID: %q\n", t.UploaderChannelID)
	fmt.Printf("artist browse ID:    %q\n", t.ArtistBrowseID)
	fmt.Printf("album:               %q\n", t.Album)
	fmt.Printf("album browse ID:     %q\n", t.AlbumBrowseID)
	fmt.Printf("renderer (via):      %s\n", t.Via)
}

func printStats(tracks []model.Track) {
	fmt.Printf("candidate count: %d\n", len(tracks))
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
	fmt.Printf("unique artists: %d | unique uploaders: %d | rows with real artist metadata: %d/%d\n",
		len(artists), len(uploaders), identified, len(tracks))
	type kv struct {
		key string
		n   int
	}
	dist := []kv{}
	for k, n := range artists {
		dist = append(dist, kv{k, n})
	}
	sort.Slice(dist, func(i, j int) bool { return dist[i].n > dist[j].n })
	for i := 0; i < len(dist) && i < 8; i++ {
		pct := 0.0
		if len(tracks) > 0 {
			pct = 100 * float64(dist[i].n) / float64(len(tracks))
		}
		fmt.Printf("  artist distribution: %-30s %2d rows (%.0f%%)\n", dist[i].key, dist[i].n, pct)
	}
	verdict := "GENUINELY MIXED (recommendation-oriented)"
	top := 0
	if len(dist) > 0 {
		top = dist[0].n
	}
	if len(tracks) >= 6 && float64(top)/float64(len(tracks)) >= 0.6 {
		verdict = "ARTIST-HEAVY (cannot define a Song Radio alone)"
	}
	fmt.Printf("verdict: %s\n", verdict)
}

func printTable(tracks []model.Track) {
	fmt.Printf("%-4s %-34s %-24s %-8s %-20s %-13s %s\n",
		"pos", "title", "artist", "artSrc", "uploader", "videoId", "renderer")
	for i, t := range tracks {
		artist := t.Artist
		if artist == "" {
			artist = "—"
		}
		uploader := t.Uploader
		if uploader == "" {
			uploader = "—"
		}
		fmt.Printf("%-4d %-34s %-24s %-8s %-20s %-13s %s\n",
			i+1, clamp(t.Title, 34), clamp(artist, 24), srcLabel(t.ArtistSrc),
			clamp(uploader, 20), t.SourceID, t.Via)
	}
}

func srcLabel(src string) string {
	switch src {
	case "browse":
		return "browse"
	case "topic":
		return "topic"
	case "metadata":
		return "meta"
	case "":
		return "NONE"
	default:
		return src
	}
}

// ytDlpPath finds a yt-dlp binary so the mix rung is genuinely attempted.
func ytDlpPath() (string, error) {
	for _, name := range []string{"yt-dlp", "yt-dlp.exe", "youtube-dl"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	if exe, err := os.Executable(); err == nil {
		for _, name := range []string{"yt-dlp", "yt-dlp.exe"} {
			sibling := filepath.Join(filepath.Dir(exe), name)
			if _, err := os.Stat(sibling); err == nil {
				return sibling, nil
			}
		}
	}
	return "", fmt.Errorf("yt-dlp not found (mix rung reported as not attempted)")
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
