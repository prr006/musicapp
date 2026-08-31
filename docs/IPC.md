# MELO IPC Contract

The complete Tauri command/event surface. TypeScript mirrors live in
`src/app/ipc/contract.ts`; Rust implementations in `src-tauri/src/commands.rs`.

## Conventions

* Commands are `snake_case`; JS call sites use the same names (arguments are
  camelCase keys, converted automatically by Tauri).
* Commands **send intent and return immediately** (`Promise<void>` for most).
  State arrives via events. `get_*` commands exist for boot/re-sync.
* Errors are human-readable strings; providers map to friendly copy via
  `ProviderError::user_message()`.

## Commands

### State reads

| Command              | Returns                  | Notes                          |
|----------------------|--------------------------|--------------------------------|
| `get_playback_state` | `PlaybackSnapshot`       | boot / reconnect               |
| `get_queue`          | `QueueView`              | boot / reconnect               |
| `get_settings`       | `Settings`               |                                |
| `get_lyrics`         | `Lyrics \| null`         | Phase 7 (model shipped)        |
| `search`             | `SearchResults`          | Phase 5 (returns honest error) |

### Transport

| Command              | Args                          |
|----------------------|-------------------------------|
| `player_toggle_play` | —                             |
| `player_play`        | —                             |
| `player_pause`       | —                             |
| `player_stop`        | —                             |
| `player_next`        | — (skips even in repeat-one)  |
| `player_previous`    | — (>3 s in → restart track)   |
| `player_seek_to`     | `{ position: number }`        |
| `player_seek_by`     | `{ delta: number }`           |
| `player_set_volume`  | `{ volume: 0..100 }`          |
| `player_toggle_mute` | —                             |
| `player_set_speed`   | `{ speed: 0.25..4 }`          |

### Queue

| Command             | Args                            |
|---------------------|---------------------------------|
| `queue_play_now`    | `{ track }`                     |
| `queue_add`         | `{ tracks: Track[] }`           |
| `queue_play_next`   | `{ tracks: Track[] }`           |
| `queue_remove`      | `{ itemId }`                    |
| `queue_jump_to`     | `{ itemId }`                    |
| `queue_move`        | `{ itemId, up: boolean }`       |
| `queue_reorder`     | `{ from, to }` (upcoming index) |
| `queue_clear_upcoming` | — (keeps current + history)  |
| `queue_clear_all`   | —                               |
| `queue_set_shuffle` | `{ enabled: boolean }`          |
| `queue_set_repeat`  | `{ mode: "off" \| "all" \| "one" }` |
| `queue_start`       | `{ tracks, shuffle }`           |
| `set_settings`      | `{ settings: Settings }`        |

### Validation (rejected with a friendly error)

* non-finite / out-of-range numbers (seek, volume, speed)
* empty `tracks` arrays; tracks without a `sourceId`
* empty `itemId`s

## Events

### `playback://state` — `PlaybackSnapshot`

Emitted only when playback-relevant state changed.

```ts
{
  status: "idle" | "loading" | "playing" | "paused" | "buffering" | "error",
  currentItemId: string | null,
  currentTrack: Track | null,
  positionSecs: number,          // last known (see position stream)
  durationSecs: number | null,
  volume: number, muted: boolean, speed: number,
  shuffle: boolean, repeat: "off" | "all" | "one",
  bufferingPct: number | null,
  error: string | null,
  queueRev: number
}
```

### `playback://position` — `PositionUpdate`

Throttled to ≥0.2 s spacing while playing; forced on seek/pause/track change.
This is the authoritative clock for progress bars and lyric highlighting.

```ts
{ positionSecs: number, durationSecs: number | null, speed: number }
```

### `queue://view` — `QueueView`

Emitted on every queue mutation.

```ts
{ current: QueueItem | null, upcoming: QueueItem[], history: QueueItem[],
  shuffle: boolean, repeat: RepeatMode, rev: number }
```

`history` is most-recent-first. `upcoming` is play order (what actually plays
next), not storage order.

### `engine://status` — `EngineStatus`

```ts
{ health: "starting" | "running" | "restarting" | "dead", message: string }
```

`message` is empty when healthy; otherwise it is ready for a toast (already
user-friendly, e.g. "Is mpv installed and on PATH?").

## Track shape (source-independent)

```ts
{
  id: string,              // "yt:<videoId>" | "local:<hash>"
  source: "youtube" | "local",
  sourceId: string,
  title: string,
  artists: [{ id, name }],
  album: { id, title } | null,
  durationSecs: number | null,
  artwork: string | null,
  isLocal: boolean,
  metadata: { year?, codec?, bitrateKbps?, genre?, isrc?, streamUrl?, extra? }
}
```
