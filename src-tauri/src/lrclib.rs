//! LRCLIB client (spec §11). <https://lrclib.net/docs>
//!
//! Strategy: disk cache first (per track, long TTL), then `GET /api/get`
//! (exact match), then `GET /api/search` + [`melo_core::lyrics::best_match`].
//! The parse/model layer lives in melo-core and is unit-tested there; this
//! module is only transport + caching.

use std::path::PathBuf;
use std::time::Duration;

use melo_core::domain::Track;
use melo_core::lyrics::{best_match, LrclibEntry, Lyrics};
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
        let title = track.title.as_str();
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
            Ok(resp) => Ok(Some(resp.into_json::<LrclibEntry>().map_err(json_err)?)),
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
            Ok(resp) => resp.into_json().map_err(json_err)?,
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

fn json_err(e: ureq::Error) -> ProviderError {
    match e {
        ureq::Error::Status(404, _) => ProviderError::NotFound,
        other => ProviderError::Detail(format!("bad lrclib payload: {other}")),
    }
}

fn map_transport(t: ureq::Transport) -> ProviderError {
    use ureq::ErrorKind;
    match t.kind() {
        ErrorKind::Dns | ErrorKind::ConnectionFailed => ProviderError::Offline,
        ErrorKind::Timeout => ProviderError::Timeout,
        other => ProviderError::Detail(format!("lrclib transport: {other}")),
    }
}
