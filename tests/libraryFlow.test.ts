/**
 * Library flows through the IPC surface: favorites, playlists CRUD/reorder,
 * search history, and listening history — all via commands + the
 * `library://updated` event, exactly like the real backend behaves.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { createMockBridge } from "@/app/ipc/mock";
import { SAMPLE_TRACKS } from "@/app/ipc/sampleData";
import type { LibraryData, PlaylistLite } from "@/types/domain";

describe("library via IPC bridge", () => {
  let bridge: ReturnType<typeof createMockBridge>;
  let latestLibrary: LibraryData | null = null;

  beforeEach(() => {
    localStorage.clear();
    bridge = createMockBridge();
    latestLibrary = null;
    bridge.on("library://updated", (data) => {
      latestLibrary = data;
    });
  });

  async function library(): Promise<LibraryData> {
    return bridge.invoke("get_library");
  }

  it("toggles favorites and emits library updates", async () => {
    const track = SAMPLE_TRACKS[SAMPLE_TRACKS.length - 1]!; // not in the seed
    await expect(bridge.invoke("favorites_toggle", { track })).resolves.toBe(true);
    expect((await library()).liked.some((t) => t.id === track.id)).toBe(true);
    expect(latestLibrary?.liked.some((t) => t.id === track.id)).toBe(true);

    await expect(bridge.invoke("favorites_toggle", { track })).resolves.toBe(false);
    expect((await library()).liked.some((t) => t.id === track.id)).toBe(false);
  });

  it("creates playlists, adds tracks, reorders and removes", async () => {
    const pl = (await bridge.invoke("playlist_create", { title: "Mix", description: null })) as PlaylistLite;
    expect(pl.title).toBe("Mix");

    await bridge.invoke("playlist_add_tracks", { playlistId: pl.id, tracks: SAMPLE_TRACKS.slice(0, 3) });
    let tracks = await bridge.invoke("playlist_tracks", { playlistId: pl.id });
    expect(tracks).toHaveLength(3);
    expect(tracks[0]!.id).toBe(SAMPLE_TRACKS[0]!.id);

    // move first track down
    await bridge.invoke("playlist_reorder_track", { playlistId: pl.id, from: 0, to: 1 });
    tracks = await bridge.invoke("playlist_tracks", { playlistId: pl.id });
    expect(tracks[0]!.id).toBe(SAMPLE_TRACKS[1]!.id);

    await bridge.invoke("playlist_remove_track", { playlistId: pl.id, trackId: SAMPLE_TRACKS[1]!.id });
    tracks = await bridge.invoke("playlist_tracks", { playlistId: pl.id });
    expect(tracks.map((t) => t.id)).toEqual([SAMPLE_TRACKS[0]!.id, SAMPLE_TRACKS[2]!.id]);
  });

  it("resolves playlist tracks that were never played or liked (v3 index)", async () => {
    const pl = (await bridge.invoke("playlist_create", { title: "Fresh", description: null })) as PlaylistLite;
    await bridge.invoke("playlist_add_tracks", { playlistId: pl.id, tracks: [SAMPLE_TRACKS[4]!] });
    const tracks = await bridge.invoke("playlist_tracks", { playlistId: pl.id });
    expect(tracks.map((t) => t.id)).toEqual([SAMPLE_TRACKS[4]!.id]);
  });

  it("renames, duplicates and deletes playlists", async () => {
    const pl = (await bridge.invoke("playlist_create", { title: "One", description: null })) as PlaylistLite;
    await bridge.invoke("playlist_add_tracks", { playlistId: pl.id, tracks: [SAMPLE_TRACKS[0]!] });

    await bridge.invoke("playlist_rename", { playlistId: pl.id, title: "Renamed" });
    expect((await library()).playlists[0]!.title).toBe("Renamed");
    const copy = (await bridge.invoke("playlist_duplicate", { playlistId: pl.id, title: "Renamed (copy)" })) as PlaylistLite;
    expect(copy.title).toBe("Renamed (copy)");
    expect((await library()).playlists).toHaveLength(2);

    await bridge.invoke("playlist_delete", { playlistId: pl.id });
    expect((await library()).playlists.map((p) => p.id)).toEqual([copy.id]);
    await expect(bridge.invoke("playlist_delete", { playlistId: "nope" })).rejects.toThrow();
  });

  it("saves a queue's tracks as a playlist (composed from library commands)", async () => {
    // The queue lives in the frontend now; saving it composes two commands.
    const saved = (await bridge.invoke("playlist_create", { title: "Saved queue", description: null })) as PlaylistLite;
    await bridge.invoke("playlist_add_tracks", {
      playlistId: saved.id,
      tracks: SAMPLE_TRACKS.slice(0, 3),
    });
    expect(saved.title).toBe("Saved queue");
    const tracks = await bridge.invoke("playlist_tracks", { playlistId: saved.id });
    expect(tracks).toHaveLength(3);
  });

  it("records listening history on playback and supports removal/clear", async () => {
    await bridge.invoke("record_play", { track: SAMPLE_TRACKS[0]! });
    const before = (await library()).history.length;
    await bridge.invoke("record_play", { track: SAMPLE_TRACKS[1]! });
    const after = await library();
    // At least one entry was finalized for the first track.
    expect(after.history.length).toBeGreaterThanOrEqual(before + 1);

    const entry = after.history[0]!;
    await bridge.invoke("history_remove", { entryId: entry.id });
    expect((await library()).history.some((h) => h.id === entry.id)).toBe(false);

    await bridge.invoke("history_clear");
    expect((await library()).history).toHaveLength(0);
  });

  it("manages search history (push, remove, clear)", async () => {
    await bridge.invoke("search", { query: "nightcall" });
    await bridge.invoke("search", { query: "daft punk" });
    let lib = await library();
    expect(lib.searchHistory).toContain("nightcall");

    await bridge.invoke("search_history_remove", { query: "nightcall" });
    lib = await library();
    expect(lib.searchHistory).not.toContain("nightcall");
    expect(lib.searchHistory).toContain("daft punk");

    await bridge.invoke("search_history_clear");
    expect((await library()).searchHistory).toHaveLength(0);
  });
});
