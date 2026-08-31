# MELO Data Model

Domain models live in `crates/melo-core/src/domain.rs` (Rust) and are mirrored
in `src/types/domain.ts` (TypeScript). Field names cross the boundary in
camelCase via serde. **Change both files in the same commit.**

## Design rules

1. **`Track` is source-independent.** Provider knowledge is confined to
   `source`, `sourceId`, and `metadata`. Nothing in playback, queue, lyrics,
   or UI may branch on YouTube specifics (resolution is a `Resolver` concern).
2. **Ids are namespaced strings** (`yt:…`, `local:…`, `qi:…`, `pl:…`) so
   mistaken identity is obvious and IPC stays friction-free.
3. **Future-facing fields ship early** (playlist folders, lyric translation,
   download states) so later phases need no migrations of the core model.

## Entities

```text
Track          id, source (youtube|local), sourceId, title, artists[ArtistRef],
               album? AlbumRef, durationSecs?, artwork?, isLocal, metadata
ArtistRef      id, name
AlbumRef       id, title
TrackMetadata  year?, codec?, bitrateKbps?, genre?, isrc?, streamUrl?, extra{}

Artist         id, name, artwork?, description?, followerCount?, isFollowed
Album          id, title, artists[], year?, releaseDate?, artwork?,
               trackCount, durationSecs?, isSaved

Playlist       id, parentId? (folders), kind (manual|smart), title,
               description?, artwork?, isFolder, createdAt?, updatedAt?,
               trackCount
PlaylistTrack  playlistId, trackId, position, addedAt?

QueueItem      id (qi:n), track            ← a track may appear N times
QueueView      current?, upcoming[], history[] (most-recent-first),
               shuffle, repeat, rev

PlaybackSnapshot  status, currentItemId?, currentTrack?, positionSecs,
                  durationSecs?, volume, muted, speed, shuffle, repeat,
                  bufferingPct?, error?, queueRev
PositionUpdate    positionSecs, durationSecs?, speed

Lyrics         synced, provider, lines[LyricLine], durationMs?
LyricLine      timeMs?, text, translation?, pronunciation?

HistoryEntry   id, track, playedAt, playedSecs, completion (0..1)
Download       id, trackId, state (queued|downloading|paused|completed|
               failed|cancelled), progress, bytesTotal?, bytesDownloaded?,
               filePath?, createdAt, error?

Settings       theme, accent, animations, reducedMotion, compact,
               showLyricsTranslation, audioQuality (low|standard|high|highest),
               volumeNormalization, crossfadeSecs (0=off), gapless,
               autoplaySimilar, resumeLastSession, closeAction
               (quit|minimize-to-tray), notificationsTrackChange,
               historyEnabled, downloadDir?
```

## Queue machine model

```text
items   : Vec<QueueItem>     canonical storage; display order when shuffle off
order   : Vec<QueueItemId>   play sequence — always a permutation of items
cursor  : Option<usize>      index into order of the loaded item
history : Vec<QueueItemId>   bounded (500), most recent last
```

Invariants are asserted in tests (see ARCHITECTURE.md §5).

## Storage plan

| Data                          | Phase 1        | Later                    |
|-------------------------------|----------------|--------------------------|
| Settings                      | `settings.json`| unchanged                |
| Session (queue/audio/pos)     | `session.json` | unchanged                |
| Library, favorites, playlists | —              | SQLite (Phase 6)         |
| History                       | —              | SQLite (Phase 9)         |
| Downloads                     | —              | SQLite + files (Phase 10)|

The JSON stores stay: they are small, human-debuggable, and atomic
(tmp + rename). SQLite appears only where collections grow unboundedly.
