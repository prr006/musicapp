//! LRCLIB client (spec §11). <https://lrclib.net/docs>
//!
//! Strategy: disk cache first (per track, long TTL), then `GET /api/get`
//! (exact match), then `GET /api/search` + [`melo_core::lyrics::best_match`].
//! The parse/model layer lives in melo-core and is unit-tested there; this
//! module is only transport + caching.

use std::path::PathBuf;
use std::time::Duration;

use melo_core::domain::Track;
use melo_core::lyrics::{best_match, clean_title_for_lyrics, LrclibEntry, Lyrics};
use melo_core::persistence::{load_json, save_json_atomic};
use melo_core::providers::ProviderError;

const USER_AGENT: &str = "MELO/0.1 (desktop music player; https://github.com/prr006/musicapp)";
const BASE: &str = "https://lrclib.net";
const CACHE_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000; // 30 days

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheEnvelope {
    fetched_at_ms: u64,
    #[serde(default)]
    instrumental: bool,
    #[serde(default)]
    entry: Option<LrclibEntry>,
}

pub struct LrclibClient {
    http: ureq::Agent,
    cache_dir: Option<PathBuf>,
}

impl LrclibClient {
    pub fn new(cache_dir: Option<PathBuf>) -> Self {
        let http = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(10))
            .user_agent(USER_AGENT)
            .build();
        Self { http, cache_dir }
    }

    /// Fetch lyrics for a track. `Ok(None)` = provider has nothing for it.
    /// Errors are categorized (`Offline`/`Timeout`/`RateLimited`/…).
    pub fn lyrics_for(&self, track: &Track) -> Result<Option<Lyrics>, ProviderError> {
        let artist = track.artists.first().map(|a| a.name.as_str()).unwrap_or("");
        // YouTube titles carry release junk ("(Official Video)") that breaks
        // provider exact-matching — query with the cleaned title, keep the
        // original for display.
        let cleaned_title = clean_title_for_lyrics(&track.title);
        let title = cleaned_title.as_str();
        let album = track.album.as_ref().map(|a| a.title.as_str()).unwrap_or("");

        if let Some(cached) = self.read_cache(track) {
            return Ok(cached);
        }

        let entry = match self.get_exact(artist, title, album, track.duration_secs) {
            Ok(Some(entry)) => Some(entry),
            Ok(None) => self.search_best(artist, title, track.duration_secs)?,
            Err(ProviderError::NotFound) => self.search_best(artist, title, track.duration_secs)?,
            Err(e) => return Err(e),
        };

        self.write_cache(track, entry.as_ref());
        Ok(entry.map(|e| e.into_lyrics()))
    }

    fn get_exact(
        &self,
        artist: &str,
        title: &str,
        album: &str,
        duration: Option<f64>,
    ) -> Result<Option<LrclibEntry>, ProviderError> {
        let mut req = self
            .http
            .get(&format!("{BASE}/api/get"))
            .set("Accept", "application/json")
            .query("track_name", title);
        if !artist.is_empty() {
            req = req.query("artist_name", artist);
        }
        if !album.is_empty() {
            req = req.query("album_name", album);
        }
        if let Some(d) = duration {
            req = req.query("duration", &format!("{}", d.round() as u64));
        }
        match req.call() {
            Ok(resp) => Ok(Some(resp.into_json::<LrclibEntry>().map_err(json_io_err)?)),
            Err(ureq::Error::Status(404, _)) => Ok(None),
            Err(ureq::Error::Status(429, _)) => Err(ProviderError::RateLimited),
            Err(ureq::Error::Status(code, _)) => {
                Err(ProviderError::Detail(format!("lrclib returned {code}")))
            }
            Err(ureq::Error::Transport(t)) => Err(map_transport(t)),
        }
    }

    fn search_best(
        &self,
        artist: &str,
        title: &str,
        duration: Option<f64>,
    ) -> Result<Option<LrclibEntry>, ProviderError> {
        let mut req = self
            .http
            .get(&format!("{BASE}/api/search"))
            .set("Accept", "application/json")
            .query("track_name", title);
        if !artist.is_empty() {
            req = req.query("artist_name", artist);
        }
        let entries: Vec<LrclibEntry> = match req.call() {
            Ok(resp) => resp.into_json().map_err(json_io_err)?,
            Err(ureq::Error::Status(404, _)) => Vec::new(),
            Err(ureq::Error::Status(429, _)) => return Err(ProviderError::RateLimited),
            Err(ureq::Error::Status(code, _)) => {
                return Err(ProviderError::Detail(format!("lrclib returned {code}")))
            }
            Err(ureq::Error::Transport(t)) => return Err(map_transport(t)),
        };
        Ok(best_match(&entries, title, artist, duration).cloned())
    }

    fn cache_path(&self, track: &Track) -> Option<PathBuf> {
        self.cache_dir.as_ref().map(|dir| {
            dir.join(format!("lyrics-{:016x}.json", melo_core::ids::fnv1a(&track.id)))
        })
    }

    fn read_cache(&self, track: &Track) -> Option<Option<Lyrics>> {
        let path = self.cache_path(track)?;
        let envelope: CacheEnvelope = load_json(&path).ok()??;
        if melo_core::ids::now_ms().saturating_sub(envelope.fetched_at_ms) > CACHE_TTL_MS {
            return None; // stale — refetch
        }
        if envelope.instrumental {
            return Some(Some(Lyrics::instrumental()));
        }
        Some(envelope.entry.map(|e| e.into_lyrics()))
    }

    fn write_cache(&self, track: &Track, entry: Option<&LrclibEntry>) {
        let Some(path) = self.cache_path(track) else { return };
        let envelope = CacheEnvelope {
            fetched_at_ms: melo_core::ids::now_ms(),
            instrumental: entry.map(|e| e.instrumental).unwrap_or(false),
            entry: entry.cloned(),
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(e) = save_json_atomic(&path, &envelope) {
            eprintln!("[melo] lyrics cache write failed: {e}");
        }
    }
}

/// `Response::into_json` in ureq 2.x returns `std::io::Error` (body read or
/// JSON parse failures). Classify those honestly.
fn json_io_err(e: std::io::Error) -> ProviderError {
    use std::io::ErrorKind as Io;
    match e.kind() {
        Io::TimedOut | Io::WouldBlock => ProviderError::Timeout,
        _ => ProviderError::Detail(format!("bad lrclib payload: {e}")),
    }
}

/// Classify a ureq transport failure against `ProviderError`.
///
/// ureq 2.x has **no** dedicated timeout `ErrorKind`: the agent-level
/// `.timeout(...)` fires inside the socket read/connect and surfaces as an
/// `ErrorKind::Io` transport whose inner `std::io::Error` is
/// `TimedOut`/`WouldBlock`. Inspect that source first, then fall back to the
/// transport kind.
fn map_transport(t: ureq::Transport) -> ProviderError {
    use std::error::Error as _;
    use ureq::ErrorKind;

    let io_timeout = t
        .source()
        .and_then(|s| s.downcast_ref::<std::io::Error>())
        .map(|io| {
            matches!(
                io.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            )
        })
        .unwrap_or(false);
    if io_timeout {
        return ProviderError::Timeout;
    }
    match t.kind() {
        ErrorKind::Dns | ErrorKind::ConnectionFailed => ProviderError::Offline,
        other => ProviderError::Detail(format!("lrclib transport: {other}")),
    }
}
