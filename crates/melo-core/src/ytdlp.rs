//! yt-dlp integration — the pure parts: JSON parsing, quality selection and
//! the resolve cache. Process spawning lives in `melo-app` (`ytdlp_proc.rs`);
//! everything here is deterministic and unit-tested against realistic
//! yt-dlp output fixtures.
//!
//! Robustness rules (spec §10): YouTube metadata is treated as *advisory*.
//! Missing uploader/channel, duration, thumbnail or title degrade to
//! sensible fallbacks; malformed entries are skipped, never fatal.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

use crate::domain::{ArtistRef, Track};
use crate::ids::fnv1a;
use crate::persistence::AudioQuality;
use crate::providers::{ProviderError, ResolvedMedia};

/// `"yt:<videoId>"` watch URL for a source id.
pub fn watch_url(source_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={source_id}")
}

/// `-f` format selector for a quality preference. Honest labels (spec §12):
/// we never claim lossless; yt-dlp falls down the `/` chain automatically.
pub fn format_selector(quality: AudioQuality) -> &'static str {
    match quality {
        AudioQuality::Low => "bestaudio[abr<=64]/bestaudio/best",
        AudioQuality::Standard => "bestaudio[abr<=128]/bestaudio/best",
        AudioQuality::High => "bestaudio[abr<=192]/bestaudio/best",
        AudioQuality::Highest => "bestaudio/best",
    }
}

/// Human label for what a selector actually targets (UI honesty).
pub fn quality_label(quality: AudioQuality) -> &'static str {
    match quality {
        AudioQuality::Low => "Low · ≤64 kbps",
        AudioQuality::Standard => "Standard · ≤128 kbps",
        AudioQuality::High => "High · ≤192 kbps",
        AudioQuality::Highest => "Highest available",
    }
}

/// Normalize channel names: `"Aster Vale - Topic"` / `"X - VEVO"` → artist.
pub fn clean_channel_name(raw: &str) -> String {
    let mut name = raw.trim();
    for suffix in [" - Topic", " - VEVO"] {
        if let Some(stripped) = name.strip_suffix(suffix) {
            name = stripped.trim();
        }
    }
    if name.is_empty() {
        "Unknown artist".to_string()
    } else {
        name.to_string()
    }
}

/// Stable artist id from a channel id (preferred) or a name hash.
pub fn artist_id(channel_id: Option<&str>, name: &str) -> String {
    match channel_id {
        Some(cid) if !cid.is_empty() => format!("ytart:{cid}"),
        _ => format!("ytart:{:016x}", fnv1a(name)),
    }
}

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn opt_secs(v: &Value, key: &str) -> Option<f64> {
    let n = v.get(key)?.as_f64()?;
    if n.is_finite() && n > 0.0 {
        Some(n)
    } else {
        None
    }
}

/// Build a `Track` from a flat playlist entry. `None` when the entry has no
/// usable video id.
pub fn track_from_flat_entry(entry: &Value) -> Option<Track> {
    let id = opt_str(entry, "id")?;
    let title = opt_str(entry, "title").unwrap_or_else(|| "(untitled)".to_string());
    let channel = opt_str(entry, "uploader")
        .or_else(|| opt_str(entry, "channel"))
        .or_else(|| opt_str(entry, "uploader_id"));
    let channel_id = opt_str(entry, "channel_id").or_else(|| opt_str(entry, "uploader_id"));
    let artist_name = channel
        .as_deref()
        .map(clean_channel_name)
        .unwrap_or_else(|| "Unknown artist".to_string());
    let artist = ArtistRef {
        id: artist_id(channel_id.as_deref(), &artist_name),
        name: artist_name,
    };
    Some(Track {
        id: format!("yt:{id}"),
        source: crate::domain::TrackSource::YouTube,
        source_id: id,
        title,
        artists: vec![artist],
        album: None, // flat search has no album; album pages refine later
        duration_secs: opt_secs(entry, "duration"),
        artwork: opt_str(entry, "thumbnail"),
        is_local: false,
        metadata: Default::default(),
    })
}

/// Parse yt-dlp `-J --flat-playlist "ytsearchN:q"` output into tracks.
/// Null entries (yt-dlp emits them for deleted videos) are skipped.
pub fn parse_search_document(json_text: &str, limit: usize) -> Result<Vec<Track>, ProviderError> {
    let root: Value = serde_json::from_str(json_text)
        .map_err(|e| ProviderError::Detail(format!("yt-dlp returned invalid JSON: {e}")))?;
    let entries = root
        .get("entries")
        .and_then(|e| e.as_array())
        .ok_or_else(|| ProviderError::Detail("yt-dlp result had no entries".into()))?;
    let mut tracks = Vec::new();
    for entry in entries {
        if tracks.len() >= limit {
            break;
        }
        if entry.is_null() {
            continue;
        }
        if let Some(track) = track_from_flat_entry(entry) {
            tracks.push(track);
        }
    }
    Ok(tracks)
}

/// Parse yt-dlp `-J -f <selector> --no-playlist <url>` output into a
/// playable media reference.
pub fn parse_resolve_document(json_text: &str) -> Result<ResolvedMedia, ProviderError> {
    let root: Value = serde_json::from_str(json_text)
        .map_err(|e| ProviderError::Detail(format!("yt-dlp returned invalid JSON: {e}")))?;
    let url = opt_str(&root, "url")
        .ok_or_else(|| ProviderError::Detail("yt-dlp gave no stream url".into()))?;
    let abr = root.get("abr").and_then(|v| v.as_f64()).filter(|v| v.is_finite() && *v > 0.0);
    Ok(ResolvedMedia {
        url,
        is_local: false,
        container: opt_str(&root, "ext"),
        bitrate_kbps: abr.map(|v| v as u32),
    })
}

/// TTL + LRU-ish (size-capped) cache for resolved stream URLs.
///
/// YouTube media URLs expire (~6h), so entries carry a TTL; the cap bounds
/// memory. Clock is injected so expiry is testable.
pub struct ResolveCache {
    inner: Mutex<HashMap<String, (u64, ResolvedMedia)>>,
    ttl_ms: u64,
    cap: usize,
}

impl ResolveCache {
    pub fn new(ttl_ms: u64, cap: usize) -> Self {
        Self { inner: Mutex::new(HashMap::new()), ttl_ms, cap }
    }

    pub fn key(source_id: &str, quality: AudioQuality) -> String {
        format!("{source_id}|{quality:?}")
    }

    pub fn get(&self, key: &str, now_ms: u64) -> Option<ResolvedMedia> {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match guard.get(key) {
            Some((created, media)) if now_ms.saturating_sub(*created) < self.ttl_ms => {
                Some(media.clone())
            }
            Some(_) => {
                guard.remove(key); // expired
                None
            }
            None => None,
        }
    }

    pub fn put(&self, key: String, media: ResolvedMedia, now_ms: u64) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if guard.len() >= self.cap && !guard.contains_key(&key) {
            // Evict the oldest entry (lowest created timestamp).
            if let Some(oldest) = guard
                .iter()
                .min_by_key(|(_, (created, _))| *created)
                .map(|(k, _)| k.clone())
            {
                guard.remove(&oldest);
            }
        }
        guard.insert(key, (now_ms, media));
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|g| g.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEARCH_DOC: &str = r#"{
        "_type": "playlist",
        "id": "ytsearch",
        "title": "test query",
        "entries": [
            {
                "id": "aaa111",
                "title": "Neon River",
                "uploader": "Aster Vale - Topic",
                "channel_id": "UCaaa111",
                "duration": 222.452,
                "thumbnail": "https://i.ytimg.com/vi/aaa111/hq720.jpg"
            },
            null,
            {
                "id": "bbb222",
                "uploader": null,
                "channel": null,
                "duration": null,
                "thumbnail": null
            },
            {
                "id": "ccc333",
                "title": "Live set (missing duration)",
                "uploader": "Club Streams",
                "duration": -1
            },
            {"title": "no id at all"}
        ]
    }"#;

    #[test]
    fn parses_search_entries_with_full_metadata() {
        let tracks = parse_search_document(SEARCH_DOC, 10).unwrap();
        assert_eq!(tracks.len(), 3); // null entry + id-less entry skipped
        let t = &tracks[0];
        assert_eq!(t.id, "yt:aaa111");
        assert_eq!(t.source_id, "aaa111");
        assert_eq!(t.title, "Neon River");
        assert_eq!(t.artists[0].name, "Aster Vale");
        assert_eq!(t.artists[0].id, "ytart:UCaaa111");
        assert!((t.duration_secs.unwrap() - 222.452).abs() < 1e-9);
        assert_eq!(t.artwork.as_deref(), Some("https://i.ytimg.com/vi/aaa111/hq720.jpg"));
        assert!(t.album.is_none());
    }

    #[test]
    fn missing_metadata_degrades_instead_of_crashing() {
        let tracks = parse_search_document(SEARCH_DOC, 10).unwrap();
        let bare = &tracks[1];
        assert_eq!(bare.title, "(untitled)");
        assert_eq!(bare.artists[0].name, "Unknown artist");
        assert!(bare.duration_secs.is_none());
        assert!(bare.artwork.is_none());
        // Unknown artist still gets a STABLE id (name hash).
        let other = parse_search_document(SEARCH_DOC, 10).unwrap();
        assert_eq!(bare.artists[0].id, other[1].artists[0].id);
        // Negative duration treated as unknown.
        assert!(tracks[2].duration_secs.is_none());
        assert_eq!(tracks[2].artists[0].name, "Club Streams");
    }

    #[test]
    fn search_limit_is_respected() {
        assert_eq!(parse_search_document(SEARCH_DOC, 2).unwrap().len(), 2);
    }

    #[test]
    fn malformed_search_json_is_an_error_not_a_crash() {
        assert!(parse_search_document("not json", 5).is_err());
        assert!(parse_search_document("{\"entries\": 3}", 5).is_err());
        assert!(parse_search_document("{}", 5).is_err());
    }

    #[test]
    fn channel_name_normalization() {
        assert_eq!(clean_channel_name("Aster Vale - Topic"), "Aster Vale");
        assert_eq!(clean_channel_name("BIGBAND - VEVO"), "BIGBAND");
        assert_eq!(clean_channel_name("  Plain Channel "), "Plain Channel");
        assert_eq!(clean_channel_name("   "), "Unknown artist");
    }

    #[test]
    fn artist_id_prefers_channel_id_then_name_hash() {
        assert_eq!(artist_id(Some("UCxyz"), "n"), "ytart:UCxyz");
        assert_eq!(artist_id(Some(""), "n"), artist_id(None, "n"));
        assert_eq!(artist_id(None, "Aster Vale"), artist_id(None, "Aster Vale"));
        assert_ne!(artist_id(None, "A"), artist_id(None, "B"));
    }

    const RESOLVE_DOC: &str = r#"{
        "id": "aaa111",
        "title": "Neon River",
        "url": "https://rr3---sn-x.googlevideo.com/videoplayback?itag=251&...",
        "ext": "webm",
        "acodec": "opus",
        "abr": 128.0,
        "format_id": "251",
        "duration": 222.452
    }"#;

    #[test]
    fn parses_resolve_document() {
        let media = parse_resolve_document(RESOLVE_DOC).unwrap();
        assert!(media.url.starts_with("https://rr3---"));
        assert_eq!(media.container.as_deref(), Some("webm"));
        assert_eq!(media.bitrate_kbps, Some(128));
        assert!(!media.is_local);
    }

    #[test]
    fn resolve_document_without_optional_fields() {
        let doc = r#"{"id":"x","url":"https://media.example/a"}"#;
        let media = parse_resolve_document(doc).unwrap();
        assert!(media.container.is_none());
        assert!(media.bitrate_kbps.is_none());
    }

    #[test]
    fn resolve_document_without_url_is_an_error() {
        assert!(parse_resolve_document(r#"{"id":"x","ext":"webm"}"#).is_err());
        assert!(parse_resolve_document("garbage").is_err());
    }

    #[test]
    fn format_selectors_fall_down_the_chain() {
        assert!(format_selector(AudioQuality::Low).contains("/bestaudio/best"));
        assert_eq!(format_selector(AudioQuality::Highest), "bestaudio/best");
        assert!(quality_label(AudioQuality::Standard).contains("128"));
    }

    #[test]
    fn resolve_cache_respects_ttl_and_cap() {
        let cache = ResolveCache::new(1000, 2);
        let media = |n: u8| ResolvedMedia {
            url: format!("https://x/{n}"),
            is_local: false,
            container: None,
            bitrate_kbps: None,
        };
        cache.put("a".into(), media(1), 0);
        assert!(cache.get("a", 500).is_some());
        assert!(cache.get("a", 1500).is_none(), "expired");
        assert!(cache.get("a", 1500).is_none(), "expired entries are purged");

        // Cap eviction, isolated from TTL: with a 1000 ms TTL, insert three
        // entries 100 ms apart and probe at a time when NONE of them can be
        // expired yet — so a miss can only mean eviction by the size cap
        // (oldest entry first).
        cache.put("b".into(), media(2), 2000);
        cache.put("c".into(), media(3), 2100);
        assert!(cache.get("c", 2100).is_some());
        cache.put("d".into(), media(4), 2200); // at cap (2) → evicts oldest: b@2000
        assert!(
            cache.get("b", 2200).is_none(),
            "b must be gone via cap eviction (only 200 ms old, not expired)"
        );
        assert!(cache.get("c", 2200).is_some());
        assert!(cache.get("d", 2200).is_some());
        assert_eq!(cache.len(), 2);

        let key = ResolveCache::key("vid", AudioQuality::High);
        assert!(key.contains("vid"));
    }
}
