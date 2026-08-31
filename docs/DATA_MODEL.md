# MELO Data Model

Authoritative shapes live in Rust (`crates/melo-core/src/domain.rs`) and are
mirrored 1:1 in TypeScript (`src/types/domain.ts`) — field names are the
serde `camelCase` output. Change both in the same commit.

## Track

```text
Track {
  id, source ("youtube"|"local"), sourceId,
  title, artists: [ArtistRef { id, name }],
  album: AlbumRef { id, title } | null,
  durationSecs: number | null,
  artwork: string | null,
  isLocal: bool,
  metadata: { year?, codec?, bitrateKbps?, genre?, isrc?, streamUrl?, extra? }
}
```

Every consumer degrades gracefully: missing artist → "Unknown artist",
missing album → hidden album column / no album grouping, missing duration →
`--:--`, missing artwork → deterministic gradient tile.

## Queue

```text
QueueItem { id, track }
QueueView { current: QueueItem|null, upcoming: [QueueItem], history: [QueueItem],
            shuffle: bool, repeat: "off"|"all"|"one", rev }
```

`rev` increments on every mutation; the frontend uses it for cheap change
detection. History is capped at 500, most-recent-first.

## Playback

```text
PlaybackStatus = idle | loading | playing | paused | buffering | error
PlaybackSnapshot { status, currentItemId, currentTrack, positionSecs,
                   durationSecs, volume (0–100), muted, speed,
                   shuffle, repeat, bufferingPct, error, queueRev }
PositionUpdate { positionSecs, durationSecs, speed }
```

`loading` ≠ `playing`: a track being resolved/loaded never shows as playing,
and `buffering` is a sub-state of sounding playback.

## Library (`library.json`, format v3)

```text
LibraryData {
  version: 3,
  liked: [Track]                       // newest first
  playlists: [Playlist]
  playlistTracks: { [playlistId]: [ { playlistId, trackId, position, addedAt } ] }
  history: [HistoryEntry]              // newest first, cap 2000
  searchHistory: [string]              // newest first, cap 20
  tracks: { [trackId]: Track }         // metadata index (v3)
}
HistoryEntry { id, track, playedAt (epoch ms), playedSecs, completion (0–1) }
```

The `tracks` index remembers every track the library ever referenced (liked,
played, or added to a playlist) so playlist rows resolve without a live
provider. v1/v2 files load via serde default-filling; the index is
backfilled from liked + history on open. Playlist timestamps are epoch
milliseconds.

## Session (`session.json`)

```text
Session { queue: [SessionItem], currentIndex, volume, muted, repeat, shuffle, savedAt }
SessionItem { track, positionSecs }
```

Restored **paused** on startup (spec §8: restart never autoplays).

## Settings (`settings.json`)

```text
Settings { theme ("dark"|"light"|"system"), accent, animations, compact,
           showLyricsTranslation, audioQuality ("low".."highest"),
           volumeNormalization, crossfadeSecs, gapless, autoplaySimilar,
           resumeLastSession, closeAction ("quit"|"minimize-to-tray"),
           notificationsTrackChange, historyEnabled, downloadDir }
```

Features not yet implemented (volume normalization, crossfade, tray,
notifications) are present as persisted preferences with honest UI labels —
they do nothing until built, and say so.

## Lyrics

```text
Lyrics { synced, provider, lines: [ { timeMs|null, text, translation?, pronunciation? } ],
         durationMs?, instrumental }
LyricLine.timeMs == null → unsynced/plain line
```

Matching rule: a lookup is only accepted when LRCLIB's duration agrees with
the track's by ≥ 25 % (`best_match`). Instrumental tracks are marked by the
provider and rendered as such.
