//! Source-independent domain model.
//!
//! The single most important rule: a `Track` describes *music*, not a YouTube
//! video. Provider-specific knowledge lives in `source` + `source_id` +
//! `metadata`, never as first-class fields. The playback engine resolves a
//! track to a playable URL at load time (see `providers::Resolver`).

use serde::{Deserialize, Serialize};

use crate::ids::{AlbumId, ArtistId, PlaylistId, TrackId};

/// Where a track came from. New providers are added here; nothing else in the
/// domain needs to change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrackSource {
    YouTube,
    Local,
}

/// A playable piece of music. Source-independent by design.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// Globally unique, prefixed by source: `"yt:dQw4w9WgXcQ"`, `"local:ab12.."`.
    pub id: TrackId,
    pub source: TrackSource,
    /// Provider-native id (video id, file hash, ...). Never empty.
    pub source_id: String,
    pub title: String,
    /// Primary artists (supporting artists live in `metadata`).
    pub artists: Vec<ArtistRef>,
    pub album: Option<AlbumRef>,
    /// Duration in seconds when known; `None` until resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<f64>,
    /// Artwork URL (remote) or `file://`/absolute path (local).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artwork: Option<String>,
    /// True when the track has been fully resolved (playable URL known).
    #[serde(default)]
    pub is_local: bool,
    #[serde(default)]
    pub metadata: TrackMetadata,
}

impl Track {
    /// Display string for the artist line, e.g. `"Aster Vale, Nova Piper"`.
    pub fn artist_line(&self) -> String {
        if self.artists.is_empty() {
            String::from("Unknown artist")
        } else {
            self.artists
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        }
    }
}

/// Lightweight artist reference embedded in tracks (full `Artist` is fetched
/// on demand for artist pages).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistRef {
    pub id: ArtistId,
    pub name: String,
}

/// Lightweight album reference embedded in tracks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumRef {
    pub id: AlbumId,
    pub title: String,
}

/// Open-ended, provider-specific extras. Unknown fields are preserved.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<u32>,
    /// e.g. `"opus"`/`"m4a"` (local) or `"webm"` (yt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    /// Average bitrate in kbps when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate_kbps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isrc: Option<String>,
    /// Playable stream/file URL once resolved (transient, not persisted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_url: Option<String>,
    /// Any provider-specific keys we want to keep without modeling them.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

/// Full artist entity (artist page).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: ArtistId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artwork: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub follower_count: Option<u64>,
    #[serde(default)]
    pub is_followed: bool,
}

/// Full album entity (album page).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: AlbumId,
    pub title: String,
    pub artists: Vec<ArtistRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artwork: Option<String>,
    #[serde(default)]
    pub track_count: u32,
    #[serde(default)]
    pub duration_secs: Option<f64>,
    #[serde(default)]
    pub is_saved: bool,
}

/// Playlist kind. Folders and smart playlists are part of the data model from
/// day one (spec §8) even though the UI ships later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaylistKind {
    /// Plain, user-managed playlist.
    Manual,
    /// Auto-generated from a rule set (future).
    Smart,
}

/// A playlist may be nested inside a folder (a playlist whose `kind` is a
/// folder is modeled as a `Playlist` with no tracks — this keeps one table).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: PlaylistId,
    /// Parent folder id when nested (folders are playlists with `is_folder`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<PlaylistId>,
    pub kind: PlaylistKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artwork: Option<String>,
    #[serde(default)]
    pub is_folder: bool,
    /// Epoch milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    /// Epoch milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    #[serde(default)]
    pub track_count: u32,
}

/// A track inside a playlist (ordered).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrack {
    pub playlist_id: PlaylistId,
    pub track_id: TrackId,
    /// 0-based position inside the playlist.
    pub position: u32,
    /// Epoch milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<u64>,
}

/// One entry of listening history (spec §15).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub track: Track,
    /// Unix epoch millis.
    pub played_at: u64,
    /// How many seconds of audio were actually rendered.
    pub played_secs: f64,
    /// 0.0 – 1.0 fraction of the track that played.
    pub completion: f64,
}

/// Persistent download record (spec §14). The media file itself lives in the
/// download directory; this row is the durable state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DownloadState {
    Queued,
    Downloading,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: String,
    pub track_id: TrackId,
    pub state: DownloadState,
    /// 0.0 – 1.0 when downloading.
    pub progress: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_downloaded: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track_serializes_camel_case_and_roundtrips() {
        let track = Track {
            id: "yt:abc".into(),
            source: TrackSource::YouTube,
            source_id: "abc".into(),
            title: "Neon River".into(),
            artists: vec![ArtistRef { id: "ytart:1".into(), name: "Aster Vale".into() }],
            album: Some(AlbumRef { id: "ytalb:2".into(), title: "Afterglow".into() }),
            duration_secs: Some(222.0),
            artwork: Some("https://example.invalid/a.jpg".into()),
            is_local: false,
            metadata: TrackMetadata::default(),
        };
        let json = serde_json::to_value(&track).unwrap();
        assert_eq!(json["sourceId"], "abc");
        assert_eq!(json["durationSecs"], 222.0);
        let back: Track = serde_json::from_value(json).unwrap();
        assert_eq!(back, track);
    }

    #[test]
    fn track_source_serializes_kebab() {
        assert_eq!(
            serde_json::to_value(TrackSource::YouTube).unwrap(),
            serde_json::json!("youtube")
        );
        assert_eq!(
            serde_json::to_value(TrackSource::Local).unwrap(),
            serde_json::json!("local")
        );
    }

    #[test]
    fn artist_line_joins_multiple_artists() {
        let track = Track {
            id: "l:1".into(),
            source: TrackSource::Local,
            source_id: "1".into(),
            title: "X".into(),
            artists: vec![
                ArtistRef { id: "a:1".into(), name: "A".into() },
                ArtistRef { id: "a:2".into(), name: "B".into() },
            ],
            album: None,
            duration_secs: None,
            artwork: None,
            is_local: true,
            metadata: TrackMetadata::default(),
        };
        assert_eq!(track.artist_line(), "A, B");
    }
}
