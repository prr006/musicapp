/**
 * Library grouping helpers: dedupe, album/artist grouping (only when metadata
 * exists — honest degradation), and history-based recommendations.
 */

import { describe, expect, it } from "vitest";

import {
  allKnownTracks,
  dedupeTracks,
  groupAlbums,
  groupArtists,
  recommendedTracks,
} from "@/lib/collection";
import type { HistoryEntry, LibraryData, Track } from "@/types/domain";

function track(id: string, over: Partial<Track> = {}): Track {
  return {
    id,
    source: "youtube",
    sourceId: id,
    title: `Track ${id}`,
    artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
    album: null,
    durationSecs: 180,
    artwork: null,
    isLocal: false,
    metadata: {},
    ...over,
  };
}

function history(tracks: Track[]): LibraryData {
  return {
    version: 2,
    liked: [],
    playlists: [],
    playlistTracks: {},
    history: tracks.map((t, i) => ({
      id: `h${i}`,
      track: t,
      playedAt: Date.now() - i * 1000,
      playedSecs: 100,
      completion: 0.5,
    })),
    searchHistory: [],
  };
}

describe("dedupeTracks", () => {
  it("keeps the first occurrence per id", () => {
    const a = track("a");
    expect(dedupeTracks([a, track("b"), a])).toHaveLength(2);
  });

  it("tolerates null-ish entries", () => {
    expect(dedupeTracks([null as unknown as Track, track("a")])).toHaveLength(1);
  });
});

describe("groupAlbums", () => {
  it("groups only tracks that carry album metadata", () => {
    const withAlbum = track("a", { album: { id: "alb1", title: "Album One" } });
    const without = track("b");
    const groups = groupAlbums([withAlbum, without, track("c", { album: { id: "alb1", title: "Album One" } })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tracks).toHaveLength(2);
    expect(groups[0]!.title).toBe("Album One");
  });

  it("survives tracks with no metadata at all", () => {
    expect(groupAlbums([track("x")])).toHaveLength(0);
  });
});

describe("groupArtists", () => {
  it("groups by primary artist id and skips artist-less tracks", () => {
    const artist = { id: "ar1", name: "Same Name" };
    const groups = groupArtists([
      track("a", { artists: [artist] }),
      track("b", { artists: [artist, { id: "ar2", name: "Feat" }] }),
      track("c", { artists: [] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tracks).toHaveLength(2);
  });
});

describe("allKnownTracks", () => {
  it("unions the metadata index with queue extras", () => {
    const lib = history([track("h1")]);
    lib.liked = [track("l1")];
    lib.tracks = { h1: lib.history[0]!.track, l1: lib.liked[0]!, pl1: track("pl1") };
    const known = allKnownTracks(lib, [track("q1")]);
    expect(known.map((t) => t.id).sort()).toEqual(["h1", "l1", "pl1", "q1"]);
  });

  it("returns extras when the library has not loaded yet", () => {
    expect(allKnownTracks(null, [track("x")]).map((t) => t.id)).toEqual(["x"]);
  });
});

describe("recommendedTracks", () => {
  it("recommends from the most-played artists only", () => {
    const fav = { id: "ar1", name: "Fav Artist" };
    const other = { id: "ar2", name: "Other" };
    const lib = history([
      track("a", { artists: [fav] }),
      track("b", { artists: [fav] }),
      track("c", { artists: [other] }),
    ]);
    const recs = recommendedTracks(lib, 2);
    expect(recs.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("is empty with no history (no fake popularity)", () => {
    const empty: LibraryData = {
      version: 3,
      liked: [track("l")],
      playlists: [],
      playlistTracks: {},
      history: [],
      searchHistory: [],
      tracks: {},
    };
    expect(recommendedTracks(empty)).toEqual([]);
  });
});
