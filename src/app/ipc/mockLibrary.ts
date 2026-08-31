/**
 * ⚠️ DEV-ONLY browser-preview library shim. ⚠️
 *
 * Mirrors the *behavior* of the real Rust `LibraryStore`
 * (crates/melo-core/src/library.rs) over localStorage so the UI can be
 * developed in a plain browser. It is NOT the product implementation and is
 * covered by mirrored test cases; the real implementation is exercised by
 * `cargo test -p melo-core`.
 */

import type { HistoryEntry, LibraryData, PlaylistLite, Track } from "@/types/domain";
import { SAMPLE_TRACKS } from "./sampleData";

const KEY = "melo:library";

function empty(): LibraryData {
  return {
    version: 3,
    liked: [],
    playlists: [],
    playlistTracks: {},
    history: [],
    searchHistory: [],
    tracks: {},
  };
}

/** v3 metadata index — mirrors Rust `remember_track`. */
function remember(data: LibraryData, track: Track): void {
  data.tracks[track.id] = { ...track };
}

let historySeq = 1;

/** First-run seed so the browser preview has something to show. */
function seed(): LibraryData {
  const data = empty();
  SAMPLE_TRACKS.forEach((t) => remember(data, t));
  data.liked = SAMPLE_TRACKS.slice(0, 3);
  data.searchHistory = ["nightcall", "daft punk"];
  const now = Date.now();
  data.history = SAMPLE_TRACKS.slice(0, 5).map((track, i) => {
    const entry: HistoryEntry = {
      id: `hist-${historySeq++}`,
      track,
      playedAt: now - i * 3_600_000,
      playedSecs: Math.round((track.durationSecs ?? 180) * 0.8),
      completion: 0.8,
    };
    return entry;
  });
  return data;
}

export class MockLibrary {
  private data: LibraryData;
  private listeners = new Set<() => void>();

  constructor() {
    this.data = this.load();
  }

  private load(): LibraryData {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LibraryData;
        const merged: LibraryData = { ...empty(), ...parsed, tracks: { ...(parsed.tracks ?? {}) } };
        // v3 backfill: index from liked + history when loading an older doc.
        for (const t of merged.liked) merged.tracks[t.id] ??= t;
        for (const h of merged.history) merged.tracks[h.track.id] ??= h.track;
        return merged;
      }
    } catch {
      /* fall through */
    }
    const seeded = seed();
    try {
      localStorage.setItem(KEY, JSON.stringify(seeded));
    } catch {
      /* storage unavailable */
    }
    return seeded;
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable */
    }
    for (const l of this.listeners) l();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): LibraryData {
    return structuredClone(this.data);
  }

  // --- favorites ------------------------------------------------------

  isLiked(trackId: string): boolean {
    return this.data.liked.some((t) => t.id === trackId);
  }

  toggleLike(track: Track): boolean {
    const idx = this.data.liked.findIndex((t) => t.id === track.id);
    if (idx >= 0) {
      this.data.liked.splice(idx, 1);
      this.save();
      return false;
    }
    remember(this.data, track);
    this.data.liked.unshift({ ...track });
    this.save();
    return true;
  }

  // --- playlists ------------------------------------------------------

  private nextId(): string {
    return `pl:${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  createPlaylist(title: string, description: string | null): PlaylistLite {
    const now = Date.now();
    const playlist: PlaylistLite = {
      id: this.nextId(),
      title: title.trim(),
      description,
      artwork: null,
      trackCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.data.playlists.unshift(playlist);
    this.data.playlistTracks[playlist.id] = [];
    this.save();
    return { ...playlist };
  }

  renamePlaylist(id: string, title: string): boolean {
    const pl = this.data.playlists.find((p) => p.id === id);
    if (!pl || !title.trim()) return false;
    pl.title = title.trim();
    pl.updatedAt = Date.now();
    this.save();
    return true;
  }

  deletePlaylist(id: string): boolean {
    const before = this.data.playlists.length;
    this.data.playlists = this.data.playlists.filter((p) => p.id !== id);
    delete this.data.playlistTracks[id];
    const changed = this.data.playlists.length !== before;
    if (changed) this.save();
    return changed;
  }

  duplicatePlaylist(id: string, title: string): PlaylistLite | null {
    const rows = this.data.playlistTracks[id];
    if (!rows) return null;
    const copy = this.createPlaylist(title, this.data.playlists.find((p) => p.id === id)?.description ?? null);
    this.addTracks(copy.id, rows.map((r) => this.trackById(r.trackId)).filter((t): t is Track => !!t));
    return this.data.playlists.find((p) => p.id === copy.id) ?? copy;
  }

  addTracks(id: string, tracks: Track[]): boolean {
    if (!this.data.playlists.some((p) => p.id === id) || tracks.length === 0) return false;
    const rows = (this.data.playlistTracks[id] ??= []);
    const now = Date.now();
    for (const t of tracks) {
      remember(this.data, t);
      rows.push({ playlistId: id, trackId: t.id, position: rows.length, addedAt: now });
    }
    this.syncCount(id);
    this.save();
    return true;
  }

  removeTrack(id: string, trackId: string): boolean {
    const rows = this.data.playlistTracks[id];
    if (!rows) return false;
    const idx = rows.findIndex((r) => r.trackId === trackId);
    if (idx === -1) return false;
    rows.splice(idx, 1);
    rows.forEach((r, i) => (r.position = i));
    this.syncCount(id);
    this.save();
    return true;
  }

  reorderTrack(id: string, from: number, to: number): boolean {
    const rows = this.data.playlistTracks[id];
    if (!rows || from >= rows.length || to >= rows.length || from === to) return false;
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row!);
    rows.forEach((r, i) => (r.position = i));
    this.save();
    return true;
  }

  playlistTracksOf(id: string): Track[] {
    const rows = this.data.playlistTracks[id] ?? [];
    return rows.map((r) => this.trackById(r.trackId)).filter((t): t is Track => !!t);
  }

  private syncCount(id: string): void {
    const pl = this.data.playlists.find((p) => p.id === id);
    if (pl) {
      pl.trackCount = this.data.playlistTracks[id]?.length ?? 0;
      pl.updatedAt = Date.now();
    }
  }

  // --- history --------------------------------------------------------

  recordPlay(track: Track): boolean {
    const head = this.data.history[0];
    if (head && head.track.id === track.id && Date.now() - head.playedAt < 30_000) return false;
    remember(this.data, track);
    this.data.history.unshift({
      id: `hi:${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      track: { ...track },
      playedAt: Date.now(),
      playedSecs: 0,
      completion: 0,
    });
    if (this.data.history.length > 2000) this.data.history.length = 2000;
    this.save();
    return true;
  }

  finishRecentFor(trackId: string, playedSecs: number, completion: number): void {
    const entry = this.data.history.find((h) => h.track.id === trackId);
    if (entry) {
      entry.playedSecs = playedSecs;
      entry.completion = Math.min(1, Math.max(0, completion));
      this.save();
    }
  }

  clearHistory(): void {
    this.data.history = [];
    this.save();
  }

  removeHistoryEntry(entryId: string): void {
    this.data.history = this.data.history.filter((h) => h.id !== entryId);
    this.save();
  }

  // --- search history ---------------------------------------------------

  pushSearch(query: string): void {
    const q = query.trim();
    if (!q) return;
    this.data.searchHistory = [q, ...this.data.searchHistory.filter((s) => s !== q)].slice(0, 20);
    this.save();
  }

  clearSearchHistory(): void {
    this.data.searchHistory = [];
    this.save();
  }

  removeSearch(query: string): void {
    this.data.searchHistory = this.data.searchHistory.filter((s) => s !== query);
    this.save();
  }

  // --- track lookup -----------------------------------------------------

  trackById(trackId: string): Track | null {
    return (
      this.data.liked.find((t) => t.id === trackId) ??
      this.data.history.find((h) => h.track.id === trackId)?.track ??
      this.data.tracks[trackId] ??
      null
    );
  }
}
