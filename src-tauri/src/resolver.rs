//! Track resolution: turn a domain `Track` into something mpv can load.
//!
//! * **Local tracks** → absolute file path (offline-safe, instant).
//! * **YouTube tracks** → yt-dlp resolves a direct media URL, selected by the
//!   user's audio-quality setting, behind a TTL cache.
//!
//! Resolution happens on worker threads (never the playback service loop):
//! the service spawns a thread that calls [`ResolverService::resolve`] and
//! posts `ToService::Resolved` back with a generation token so a stale
//! result (user hit Next mid-resolve) can never load the wrong file.

use std::path::Path;
use std::sync::Arc;

use melo_core::domain::{Track, TrackSource};
use melo_core::persistence::AudioQuality;
use melo_core::providers::{ProviderError, ResolvedMedia};
use melo_core::ytdlp::{self, ResolveCache};

use crate::runtime::RuntimeHandle;
use crate::settings_store::SettingsStore;
use crate::ytdlp_proc;

const RESOLVE_CACHE_TTL_MS: u64 = 2 * 60 * 60 * 1000; // 2h (media URLs live ~6h)
const RESOLVE_CACHE_CAP: usize = 200;

pub struct ResolverService {
    /// Live runtime view — the bootstrap can install yt-dlp while the app
    /// runs, so the path is read per call, never cached at startup.
    runtime: RuntimeHandle,
    cache: ResolveCache,
    settings: Arc<SettingsStore>,
}

impl ResolverService {
    pub fn new(settings: Arc<SettingsStore>, runtime: RuntimeHandle) -> Self {
        Self {
            runtime,
            cache: ResolveCache::new(RESOLVE_CACHE_TTL_MS, RESOLVE_CACHE_CAP),
            settings,
        }
    }

    pub fn ytdlp_path(&self) -> Option<String> {
        self.runtime.ytdlp_path_string()
    }

    /// Where the yt-dlp binary lives, if found (for the About/settings UI).
    pub fn ytdlp_found(&self) -> bool {
        self.runtime.ytdlp_found()
    }

    /// Resolve synchronously (worker-thread context only).
    pub fn resolve(&self, track: &Track) -> Result<ResolvedMedia, ProviderError> {
        match track.source {
            TrackSource::Local => {
                let path = Path::new(&track.source_id);
                if !path.exists() {
                    return Err(ProviderError::NotFound);
                }
                Ok(ResolvedMedia {
                    url: path.to_string_lossy().into_owned(),
                    is_local: true,
                    container: path.extension().map(|e| e.to_string_lossy().into_owned()),
                    bitrate_kbps: track.metadata.bitrate_kbps,
                })
            }
            TrackSource::YouTube => {
                if track.source_id.is_empty() {
                    return Err(ProviderError::InvalidInput);
                }
                let quality = self.settings.get().audio_quality;
                let key = ResolveCache::key(&track.source_id, quality);
                let now = melo_core::ids::now_ms();
                if let Some(hit) = self.cache.get(&key, now) {
                    return Ok(hit);
                }
                let binary = self.runtime.ytdlp().ok_or(ProviderError::Detail(
                    "yt-dlp runtime missing — Settings → Diagnostics → Repair runtime".into(),
                ))?;
                let media = ytdlp_proc::resolve(&binary, &track.source_id, quality)?;
                self.cache.put(key, media.clone(), now);
                Ok(media)
            }
        }
    }

    /// Run a YouTube search (worker-thread context only).
    pub fn search(&self, query: &str, limit: u32) -> Result<Vec<Track>, ProviderError> {
        let binary = self.runtime.ytdlp().ok_or(ProviderError::Detail(
            "yt-dlp runtime missing — Settings → Diagnostics → Repair runtime".into(),
        ))?;
        ytdlp_proc::search(&binary, query, limit)
    }

    /// Human-readable quality label for the current setting.
    pub fn quality_label(&self) -> &'static str {
        ytdlp::quality_label(self.settings.get().audio_quality)
    }
}

/// Maps an `AudioQuality` to its selector (exposed for tests).
pub fn selector_for(quality: AudioQuality) -> &'static str {
    ytdlp::format_selector(quality)
}
