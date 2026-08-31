//! Phase-1 stream resolver.
//!
//! `Resolver` turns a `Track` into a URL mpv can load. Phase 1 uses the
//! simplest correct strategy:
//!
//! * **Local tracks** → absolute file path (works offline).
//! * **YouTube tracks** → the canonical watch URL; mpv's built-in `ytdl_hook`
//!   delegates to yt-dlp at load time.
//!
//! Phase 5 replaces the YouTube arm with explicit yt-dlp invocation inside
//! MELO (better errors, quality selection, caching, offline reuse) — the
//! trait boundary stays identical.

use std::path::PathBuf;

use melo_core::domain::{Track, TrackSource};
use melo_core::providers::{ProviderError, ResolvedMedia, Resolver};

pub struct DirectResolver {
    /// Extra directories to search for mpv/yt-dlp helper binaries (Windows).
    _resource_dir: Option<PathBuf>,
}

impl DirectResolver {
    pub fn new() -> Self {
        Self { _resource_dir: None }
    }
}

impl Default for DirectResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl Resolver for DirectResolver {
    fn resolve(&self, track: &Track) -> Result<ResolvedMedia, ProviderError> {
        match track.source {
            TrackSource::Local => {
                let path = PathBuf::from(&track.source_id);
                if !path.exists() {
                    return Err(ProviderError::NotFound);
                }
                Ok(ResolvedMedia {
                    url: path.to_string_lossy().into_owned(),
                    is_local: true,
                    container: path
                        .extension()
                        .map(|e| e.to_string_lossy().into_owned()),
                    bitrate_kbps: track.metadata.bitrate_kbps,
                })
            }
            TrackSource::YouTube => {
                if track.source_id.is_empty() {
                    return Err(ProviderError::InvalidInput);
                }
                Ok(ResolvedMedia {
                    url: format!("https://www.youtube.com/watch?v={}", track.source_id),
                    is_local: false,
                    container: None,
                    bitrate_kbps: None,
                })
            }
        }
    }
}
