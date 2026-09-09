package api

import (
	"fmt"
	"testing"

	"melo/internal/model"
)

func radioTrack(id, title, artist string) model.Track {
	return model.Track{ID: "yt:" + id, SourceID: id, Source: "youtube", Title: title, Artist: artist}
}

func TestDiverseRadioTracksCapsAndSpacesArtistsAcrossFifteenResults(t *testing.T) {
	input := make([]model.Track, 0, 30)
	for i := 0; i < 10; i++ {
		input = append(input, radioTrack(fmt.Sprintf("seed%07d", i), fmt.Sprintf("Seed song %d", i), "Seed Artist"))
	}
	for artist := 0; artist < 8; artist++ {
		for song := 0; song < 2; song++ {
			input = append(input, radioTrack(
				fmt.Sprintf("mix%d%07d", artist, song),
				fmt.Sprintf("Mix %d song %d", artist, song),
				fmt.Sprintf("Related Artist %d", artist),
			))
		}
	}

	got := diverseRadioTracks(input, 15)
	if len(got) != 15 {
		t.Fatalf("expected 15 recommendations, got %d: %+v", len(got), got)
	}
	counts := map[string]int{}
	last := ""
	for index, track := range got {
		artist := radioArtistKey(track.Artist, track.ID)
		counts[artist]++
		if counts[artist] > radioArtistLimit {
			t.Fatalf("artist %q exceeded cap in %+v", track.Artist, got)
		}
		if index > 0 && artist == last {
			t.Fatalf("consecutive artist run at %d: %+v", index, got)
		}
		last = artist
	}
	if counts[canonical("Seed Artist")] != 2 {
		t.Fatalf("expected relevant seed artist to remain, got counts %+v", counts)
	}
	if len(counts) < 7 {
		t.Fatalf("recommendations are not diverse enough: %+v", counts)
	}
}

func TestRadioSupplementalQueriesWalkRelatedArtistsBeforeGenericSearches(t *testing.T) {
	base := []model.Track{
		radioTrack("seed0000001", "Believer", "Imagine Dragons"),
		radioTrack("seed0000002", "Thunder", "Imagine Dragons"),
		radioTrack("pivot000001", "A Remix", "Kaskade, Imagine Dragons"),
		radioTrack("pivot000002", "Related One", "OneRepublic"),
		radioTrack("pivot000003", "Related Two", "X Ambassadors"),
		radioTrack("pivot000004", "Related Three", "OneRepublic"),
	}

	got := radioSupplementalQueries(base, "Imagine Dragons", "Believer")
	want := []string{"Kaskade", "OneRepublic", "X Ambassadors"}
	if len(got) != len(want) {
		t.Fatalf("unexpected query count: got %v want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("unexpected pivot order: got %v want %v", got, want)
		}
	}
}

func TestRadioSupplementalQueriesFillThreeContextSearchesWithoutPivots(t *testing.T) {
	base := []model.Track{
		radioTrack("seed0000001", "Believer", "Imagine Dragons"),
		radioTrack("seed0000002", "Thunder", "Imagine Dragons"),
	}

	got := radioSupplementalQueries(base, "Imagine Dragons", "Believer")
	want := []string{
		"Believer song radio",
		"Imagine Dragons similar music",
		"Imagine Dragons related artists",
	}
	if len(got) != len(want) {
		t.Fatalf("unexpected query count: got %v want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("unexpected context query order: got %v want %v", got, want)
		}
	}
}

func TestDiverseRadioTracksKeepsCanonicalSongAndIDDeduplication(t *testing.T) {
	input := []model.Track{
		radioTrack("duplicate01", "Believer", "Imagine Dragons"),
		radioTrack("duplicate02", "Believer", "Cover Artist"),
		radioTrack("duplicate01", "Different metadata", "Other Artist"),
		radioTrack("fresh000001", "Fresh Song", "Related Artist"),
	}
	got := diverseRadioTracks(input, 15)
	if len(got) != 2 || got[0].ID != "yt:duplicate01" || got[1].ID != "yt:fresh000001" {
		t.Fatalf("unexpected canonical dedupe: %+v", got)
	}
}
