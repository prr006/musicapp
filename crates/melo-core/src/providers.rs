//! External content providers (search + stream resolution).
//!
//! The player never talks to YouTube directly — it talks to `Resolver` and
//! `SearchProvider`. Phase 5 implements both on top of yt-dlp; local music
//! (Phase 11) implements them on top of the file scanner; future providers
//! plug in the same way. This is what keeps `Track` source-independent
//! (spec §13).

use crate::domain::{Album, Artist, Playlist, Track};

/// Search results grouped by kind (spec §5).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub tracks: Vec<Track>,
    pub artists: Vec<Artist>,
    pub albums: Vec<Album>,
    pub playlists: Vec<Playlist>,
    /// Echo of the query + provider, for UI headers and logging.
    pub query: String,
}

/// Resolve a track into a playable stream/file URL + enriched metadata.
///
/// Implementations MUST be side-effect free apart from caching: the playback
/// service calls this on the hot path whenever a track loads.
pub trait SearchProvider {
    fn search(&self, query: &str, limit: u32) -> Result<SearchResults, ProviderError>;
}

/// Anything that can turn a track into a playable URL.
pub trait Resolver: Send + Sync {
    /// `Ok(None)` means "cannot resolve" (e.g. offline) — the caller surfaces
    /// a friendly error and moves on; it must never panic or block forever.
    fn resolve(&self, track: &Track) -> Result<ResolvedMedia, ProviderError>;
}

/// A resolved, immediately playable media reference.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedMedia {
    /// URL or absolute file path the engine can load.
    pub url: String,
    /// True when the media is fully local (downloads, imports) — offline-safe.
    pub is_local: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate_kbps: Option<u32>,
}

/// Provider failures mapped to friendly, actionable categories (spec §29).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderError {
    Offline,
    Timeout,
    NotFound,
    RateLimited,
    InvalidInput,
    /// Provider-specific message for logs; NOT shown raw to users.
    Detail(String),
}

impl ProviderError {
    /// Friendly, user-facing copy (spec §29: never "nothing happened").
    pub fn user_message(&self) -> &'static str {
        match self {
            ProviderError::Offline => "You're offline. Reconnect and try again.",
            ProviderError::Timeout => "That took too long. Check your connection and retry.",
            ProviderError::NotFound => "Couldn't find this anymore. It may have been removed.",
            ProviderError::RateLimited => "Too many requests. Wait a moment and try again.",
            ProviderError::InvalidInput => "That request wasn't valid.",
            ProviderError::Detail(_) => "Something went wrong. Try again in a moment.",
        }
    }

    pub fn log_message(&self) -> String {
        match self {
            ProviderError::Detail(d) => format!("detail: {d}"),
            other => format!("{other:?}"),
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.log_message())
    }
}

impl std::error::Error for ProviderError {}
