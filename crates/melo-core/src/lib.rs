//! # melo-core
//!
//! The engine-agnostic heart of MELO. Everything in this crate is pure,
//! synchronous, and unit-testable: no Tauri, no mpv, no HTTP, no async.
//!
//! Layers:
//!
//! * [`domain`] — source-independent data model (`Track`, `Artist`, `Album`,
//!   `Playlist`, ...). Nothing here may be YouTube-specific.
//! * [`player`] — the *player abstraction*: `PlayerCommand` and `EngineEvent`
//!   form a data protocol between the playback state machine and any backend
//!   (mpv today, something else tomorrow).
//! * [`queue`] — the queue state machine (order, history, shuffle, repeat).
//! * [`playback`] — the playback state machine. Single owner of truth: it
//!   consumes `EngineEvent`s and `UserCommand`s and emits `PlayerCommand`s
//!   plus dirty flags for the host application to publish.
//! * [`lyrics`] — LRC parsing and position-indexed lyric lookup.
//! * [`persistence`] — serializable session/settings snapshots.
//! * [`providers`] — traits for external content sources (YouTube, local).

pub mod domain;
pub mod library;
pub mod lyrics;
pub mod persistence;
pub mod playback;
pub mod player;
pub mod providers;
pub mod queue;
pub mod ytdlp;

pub mod ids {
    //! Opaque string identifiers. Kept as plain strings so they cross the
    //! IPC boundary without friction, but always namespaced by prefix
    //! (`tr:`, `qi:`, `pl:`, ...) to make mistaken identity obvious.

    /// Unique id for a track, e.g. `"yt:dQw4w9WgXcQ"` or `"local:sha256..."`.
    pub type TrackId = String;
    /// Unique id for a queue entry. A track can appear in a queue multiple
    /// times; each entry gets a distinct id (`"qi:17"`).
    pub type QueueItemId = String;
    /// Unique id for an artist (`"ytart:UC..."`, `"localart:..."`).
    pub type ArtistId = String;
    /// Unique id for an album (`"ytalb:MPREb_..."`, `"localalb:..."`).
    pub type AlbumId = String;
    /// Unique id for a playlist (`"pl:3"`).
    pub type PlaylistId = String;

    /// Monotonic id generator (time-based + counter), no external deps.
    pub fn new_id(prefix: &str) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        format!("{prefix}:{n:x}-{nanos:x}")
    }

    /// FNV-1a — stable, version-independent hash used for cache keys and
    /// derived ids (DefaultHasher is not guaranteed stable across rustc
    /// releases, which would silently invalidate caches).
    pub fn fnv1a(s: &str) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in s.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01B3);
        }
        h
    }

    /// Current unix time in milliseconds (best effort, never panics).
    pub fn now_ms() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}
