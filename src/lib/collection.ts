/**
 * Library grouping helpers (pure): derive album/artist collections from the
 * union of all tracks the app knows about. YouTube flat search has no album
 * metadata, so album groups only appear where metadata exists (graceful
 * degradation, spec §10).
 */

import type { LibraryData, Track } from "@/types/domain";

export interface AlbumGroup {
  albumId: string;
  title: string;
  artistName: string;
  year: number | null;
  tracks: Track[];
}

export interface ArtistGroup {
  artistId: string;
  name: string;
  tracks: Track[];
}

/** Dedupe by track id, first occurrence wins. */
export function dedupeTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const t of tracks) {
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/**
 * All tracks the app knows about. The v3 metadata index (`library.tracks`)
 * already covers liked + history + playlist-referenced tracks, so this is
 * the index plus any queue extras not yet persisted.
 */
export function allKnownTracks(library: LibraryData | null, extra: Track[] = []): Track[] {
  if (!library) return dedupeTracks(extra);
  return dedupeTracks([...extra, ...Object.values(library.tracks)]);
}

/** Group tracks that carry album metadata. */
export function groupAlbums(tracks: Track[]): AlbumGroup[] {
  const map = new Map<string, AlbumGroup>();
  for (const t of tracks) {
    if (!t.album?.id) continue;
    const existing = map.get(t.album.id);
    if (existing) {
      existing.tracks.push(t);
    } else {
      map.set(t.album.id, {
        albumId: t.album.id,
        title: t.album.title || "Unknown album",
        artistName: t.artists.map((a) => a.name).join(", ") || "Unknown artist",
        year: t.metadata?.year ?? null,
        tracks: [t],
      });
    }
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** Group tracks by primary artist. */
export function groupArtists(tracks: Track[]): ArtistGroup[] {
  const map = new Map<string, ArtistGroup>();
  for (const t of tracks) {
    const artist = t.artists[0];
    if (!artist?.id) continue;
    const existing = map.get(artist.id);
    if (existing) {
      existing.tracks.push(t);
    } else {
      map.set(artist.id, { artistId: artist.id, name: artist.name || "Unknown artist", tracks: [t] });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Simple local recommendations: most-played artists' tracks first (spec §6). */
export function recommendedTracks(library: LibraryData | null, limit = 8): Track[] {
  if (!library || library.history.length === 0) return [];
  const counts = new Map<string, number>();
  for (const h of library.history) {
    const artistId = h.track.artists[0]?.id ?? h.track.id;
    counts.set(artistId, (counts.get(artistId) ?? 0) + 1);
  }
  const topArtists = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => id);
  const pool = dedupeTracks(library.history.map((h) => h.track)).filter((t) =>
    topArtists.includes(t.artists[0]?.id ?? t.id),
  );
  return pool.slice(0, limit);
}
