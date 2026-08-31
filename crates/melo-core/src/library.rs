//! The user library: favorites, playlists, listening history and search
//! history — all persistent structured storage (spec §8, §15, §31).
//!
//! Storage decision: a JSON document (`library.json`) written atomically,
//! NOT SQLite. For a local-first player whose library is bounded by what a
//! human actually likes/plays (thousands of entries, a few MB), a
//! single-document store is smaller, dependency-free, human-debuggable and
//! crash-safe via tmp+rename. The `LibraryStore` wrapper is the only owner
//! of the file, so if collections ever outgrow this model the storage can
//! move to SQLite behind the same API without touching callers.
//!
//! All mutations go through [`LibraryStore::with_mut`], which serializes
//! access with one mutex and saves after every change (writes are small and
//! user-paced). History is capped so the file stays bounded.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::domain::{HistoryEntry, Playlist, PlaylistTrack, Track};
use crate::ids;
use crate::persistence::{load_json, save_json_atomic};

const LIBRARY_FORMAT_VERSION: u32 = 3;
const HISTORY_CAP: usize = 2000;
const SEARCH_HISTORY_CAP: usize = 20;
/// Re-plays of the same track within this window collapse into one entry
/// (repeat-one spam, seeking back to start).
const RECORD_DEDUPE_WINDOW_MS: u64 = 30_000;

/// The whole library document. Every field has a serde default so older
/// files (and future files with unknown fields) load without error — that
/// default-filling *is* the migration path (see `migration_*` tests).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryData {
    pub version: u32,
    /// Liked tracks, newest first.
    pub liked: Vec<Track>,
    pub playlists: Vec<Playlist>,
    /// Playlist tracks keyed by playlist id, ordered by `position`.
    pub playlist_tracks: BTreeMap<String, Vec<PlaylistTrack>>,
    /// Listening history, newest first, capped at [`HISTORY_CAP`].
    pub history: Vec<HistoryEntry>,
    /// Recent search queries, newest first, capped.
    pub search_history: Vec<String>,
    /// Metadata index of every track the library has ever referenced
    /// (liked, played, or added to a playlist). Playlist rows store only
    /// ids; this map is how they resolve back to full `Track`s even when
    /// the track was never played or liked. Populated lazily by
    /// [`LibraryData::remember_track`] and backfilled on load.
    pub tracks: BTreeMap<String, Track>,
}

impl LibraryData {
    pub fn new() -> Self {
        Self { version: LIBRARY_FORMAT_VERSION, ..Default::default() }
    }

    // ------------------------------------------------------------------
    // Favorites
    // ------------------------------------------------------------------

    pub fn is_liked(&self, track_id: &str) -> bool {
        self.liked.iter().any(|t| t.id == track_id)
    }

    /// Toggle like. Returns the new state.
    pub fn toggle_like(&mut self, track: &Track) -> bool {
        if let Some(pos) = self.liked.iter().position(|t| t.id == track.id) {
            self.liked.remove(pos);
            false
        } else {
            self.remember_track(track);
            self.liked.insert(0, track.clone());
            true
        }
    }

    /// Upsert a track into the metadata index (id-keyed, last write wins).
    pub fn remember_track(&mut self, track: &Track) {
        self.tracks.insert(track.id.clone(), track.clone());
    }

    /// Rebuild the metadata index from liked + history after loading an
    /// older file. Unknown playlist references stay unknown (no data was
    /// ever stored for them) — same as before this index existed.
    pub fn backfill_track_index(&mut self) {
        let liked = self.liked.clone();
        for t in &liked {
            self.remember_track(t);
        }
        let history_tracks: Vec<Track> =
            self.history.iter().map(|h| h.track.clone()).collect();
        for t in &history_tracks {
            self.remember_track(t);
        }
    }

    // ------------------------------------------------------------------
    // Playlists
    // ------------------------------------------------------------------

    pub fn playlist(&self, id: &str) -> Option<&Playlist> {
        self.playlists.iter().find(|p| p.id == id)
    }

    fn next_playlist_id(&self) -> String {
        loop {
            let id = ids::new_id("pl");
            if self.playlist(&id).is_none() {
                return id;
            }
        }
    }

    pub fn create_playlist(&mut self, title: &str, description: Option<String>) -> Playlist {
        let now = ids::now_ms();
        let playlist = Playlist {
            id: self.next_playlist_id(),
            parent_id: None,
            kind: crate::domain::PlaylistKind::Manual,
            title: title.trim().to_string(),
            description,
            artwork: None,
            is_folder: false,
            created_at: Some(now),
            updated_at: Some(now),
            track_count: 0,
        };
        self.playlists.insert(0, playlist.clone());
        self.playlist_tracks.insert(playlist.id.clone(), Vec::new());
        playlist
    }

    /// Returns false when the playlist does not exist or the title is empty.
    pub fn rename_playlist(&mut self, id: &str, title: &str) -> bool {
        let title = title.trim();
        if title.is_empty() {
            return false;
        }
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == id) {
            p.title = title.to_string();
            p.updated_at = Some(ids::now_ms());
            true
        } else {
            false
        }
    }

    pub fn set_playlist_description(&mut self, id: &str, description: Option<String>) -> bool {
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == id) {
            p.description = description;
            p.updated_at = Some(ids::now_ms());
            true
        } else {
            false
        }
    }

    pub fn delete_playlist(&mut self, id: &str) -> bool {
        let before = self.playlists.len();
        self.playlists.retain(|p| p.id != id);
        self.playlist_tracks.remove(id);
        // Folders: playlists may be nested; drop the parent link of children.
        for p in self.playlists.iter_mut() {
            if p.parent_id.as_deref() == Some(id) {
                p.parent_id = None;
            }
        }
        before != self.playlists.len()
    }

    pub fn duplicate_playlist(&mut self, id: &str, new_title: &str) -> Option<Playlist> {
        let source_tracks = self.playlist_tracks.get(id)?.clone();
        let mut copy = self.create_playlist(new_title, self.playlist(id).and_then(|p| p.description.clone()));
        let now = ids::now_ms();
        for (i, pt) in source_tracks.into_iter().enumerate() {
            self.playlist_tracks.entry(copy.id.clone()).or_default().push(PlaylistTrack {
                playlist_id: copy.id.clone(),
                track_id: pt.track_id,
                position: i as u32,
                added_at: Some(now),
            });
        }
        copy.track_count = source_tracks.len() as u32;
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == copy.id) {
            p.track_count = copy.track_count;
        }
        Some(copy)
    }

    /// Track lookup across the library (liked, then history).
    pub fn track_by_id(&self, track_id: &str) -> Option<Track> {
        self.find_stored_track(track_id)
    }

    fn find_stored_track(&self, track_id: &str) -> Option<Track> {
        if let Some(t) = self.liked.iter().find(|t| t.id == track_id) {
            return Some(t.clone());
        }
        if let Some(h) = self.history.iter().find(|h| h.track.id == track_id) {
            return Some(h.track.clone());
        }
        self.tracks.get(track_id).cloned()
    }

    /// Append tracks to a playlist (duplicates allowed, Spotify-style).
    pub fn playlist_add_tracks(&mut self, id: &str, tracks: &[Track]) -> bool {
        let exists = self.playlists.iter().any(|p| p.id == id);
        if !exists || tracks.is_empty() {
            return exists && !tracks.is_empty();
        }
        let now = ids::now_ms();
        let entry = self.playlist_tracks.entry(id.to_string()).or_default();
        for track in tracks {
            let position = entry.len() as u32;
            self.remember_track(track);
            entry.push(PlaylistTrack {
                playlist_id: id.to_string(),
                track_id: track.id.clone(),
                position,
                added_at: Some(now),
            });
        }
        self.sync_playlist_count(id);
        true
    }

    /// Remove the track at `position`. Returns false when out of range.
    pub fn playlist_remove_at(&mut self, id: &str, position: usize) -> bool {
        let Some(entry) = self.playlist_tracks.get_mut(id) else { return false };
        if position >= entry.len() {
            return false;
        }
        entry.remove(position);
        self.renumber(id);
        self.sync_playlist_count(id);
        true
    }

    /// Remove the first occurrence of `track_id`.
    pub fn playlist_remove_track(&mut self, id: &str, track_id: &str) -> bool {
        let Some(entry) = self.playlist_tracks.get_mut(id) else { return false };
        let before = entry.len();
        if let Some(pos) = entry.iter().position(|pt| pt.track_id == track_id) {
            entry.remove(pos);
        }
        if entry.len() != before {
            self.renumber(id);
            self.sync_playlist_count(id);
            true
        } else {
            false
        }
    }

    /// Move the track at `from` to `to` (both indexes into the playlist).
    pub fn playlist_reorder(&mut self, id: &str, from: usize, to: usize) -> bool {
        let Some(entry) = self.playlist_tracks.get_mut(id) else { return false };
        if from >= entry.len() || to >= entry.len() || from == to {
            return false;
        }
        let pt = entry.remove(from);
        entry.insert(to, pt);
        self.renumber(id);
        true
    }

    pub fn playlist_track_ids(&self, id: &str) -> Vec<String> {
        self.playlist_tracks
            .get(id)
            .map(|v| v.iter().map(|pt| pt.track_id.clone()).collect())
            .unwrap_or_default()
    }

    fn renumber(&mut self, id: &str) {
        if let Some(entry) = self.playlist_tracks.get_mut(id) {
            for (i, pt) in entry.iter_mut().enumerate() {
                pt.position = i as u32;
            }
        }
    }

    fn sync_playlist_count(&mut self, id: &str) {
        let count = self
            .playlist_tracks
            .get(id)
            .map(|v| v.len() as u32)
            .unwrap_or(0);
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == id) {
            p.track_count = count;
            p.updated_at = Some(ids::now_ms());
        }
    }

    // ------------------------------------------------------------------
    // Listening history
    // ------------------------------------------------------------------

    /// Record that `track` started playing. Re-plays of the same track
    /// within [`RECORD_DEDUPE_WINDOW_MS`] are collapsed. Returns true when a
    /// new entry was created.
    pub fn record_play(&mut self, track: &Track, now_ms: u64) -> bool {
        if let Some(head) = self.history.first() {
            if head.track.id == track.id
                && now_ms.saturating_sub(head.played_at) < RECORD_DEDUPE_WINDOW_MS
            {
                return false;
            }
        }
        self.remember_track(track);
        let entry = HistoryEntry {
            id: ids::new_id("hi"),
            track: track.clone(),
            played_at: now_ms,
            played_secs: 0.0,
            completion: 0.0,
        };
        self.history.insert(0, entry);
        if self.history.len() > HISTORY_CAP {
            self.history.truncate(HISTORY_CAP);
        }
        true
    }

    /// Finalize the most recent entry for `track_id` with the position it
    /// reached (seconds) so completion can be derived from duration.
    pub fn finish_recent_for(&mut self, track_id: &str, played_secs: f64, completion: f64) -> bool {
        let completion = completion.clamp(0.0, 1.0);
        let played_secs = if played_secs.is_finite() && played_secs > 0.0 {
            played_secs
        } else {
            0.0
        };
        if let Some(entry) = self
            .history
            .iter_mut()
            .find(|h| h.track.id == track_id)
        {
            entry.played_secs = played_secs;
            entry.completion = completion;
            true
        } else {
            false
        }
    }

    /// Distinct recently played tracks, newest first.
    pub fn recently_played(&self, limit: usize) -> Vec<Track> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for entry in &self.history {
            if seen.insert(entry.track.id.clone()) {
                out.push(entry.track.clone());
                if out.len() >= limit {
                    break;
                }
            }
        }
        out
    }

    /// Play counts per track id (used for recommendations).
    pub fn play_counts(&self) -> BTreeMap<String, u32> {
        let mut counts = BTreeMap::new();
        for entry in &self.history {
            *counts.entry(entry.track.id.clone()).or_insert(0u32) += 1;
        }
        counts
    }

    pub fn remove_history_entry(&mut self, entry_id: &str) -> bool {
        let before = self.history.len();
        self.history.retain(|h| h.id != entry_id);
        before != self.history.len()
    }

    pub fn clear_history(&mut self) {
        self.history.clear();
    }

    // ------------------------------------------------------------------
    // Search history
    // ------------------------------------------------------------------

    pub fn push_search(&mut self, query: &str) {
        let q = query.trim();
        if q.is_empty() {
            return;
        }
        self.search_history.retain(|s| s != q);
        self.search_history.insert(0, q.to_string());
        if self.search_history.len() > SEARCH_HISTORY_CAP {
            self.search_history.truncate(SEARCH_HISTORY_CAP);
        }
    }

    pub fn clear_search_history(&mut self) {
        self.search_history.clear();
    }

    pub fn remove_search(&mut self, query: &str) {
        self.search_history.retain(|s| s != query);
    }

    // ------------------------------------------------------------------
    // Invariants
    // ------------------------------------------------------------------

    pub fn assert_invariants(&self) -> Result<(), String> {
        if self.liked.len() > LIBRARY_FORMAT_VERSION as usize * 100_000 {
            return Err("liked list unreasonably large".into());
        }
        let playlist_ids: std::collections::HashSet<&String> =
            self.playlists.iter().map(|p| &p.id).collect();
        if playlist_ids.len() != self.playlists.len() {
            return Err("duplicate playlist ids".into());
        }
        for (id, tracks) in &self.playlist_tracks {
            if !playlist_ids.contains(id) {
                return Err(format!("track rows for missing playlist {id}"));
            }
            for (i, pt) in tracks.iter().enumerate() {
                if pt.position != i as u32 {
                    return Err(format!("playlist {id}: position {i} stored as {}", pt.position));
                }
                if pt.playlist_id != *id {
                    return Err(format!("playlist {id}: row points at {}", pt.playlist_id));
                }
            }
        }
        for p in &self.playlists {
            let rows = self.playlist_tracks.get(&p.id).map(|v| v.len()).unwrap_or(0);
            if p.track_count as usize != rows {
                return Err(format!(
                    "playlist {} count {} != rows {rows}",
                    p.id, p.track_count
                ));
            }
            if p.title.trim().is_empty() {
                return Err(format!("playlist {} has empty title", p.id));
            }
        }
        if self.history.len() > HISTORY_CAP {
            return Err("history exceeds cap".into());
        }
        Ok(())
    }
}

/// Persistent, thread-safe wrapper: the single owner of `library.json`.
pub struct LibraryStore {
    path: PathBuf,
    data: Mutex<LibraryData>,
}

impl LibraryStore {
    /// Load (or recover from corruption). Never fails: a corrupt file is
    /// backed up as `library.json.corrupt` and a fresh library starts.
    pub fn open(path: &Path) -> Self {
        let (data, recovered) = match load_json::<LibraryData>(path) {
            Ok(Some(loaded)) => {
                let mut d = loaded;
                if d.version == 0 {
                    d.version = LIBRARY_FORMAT_VERSION;
                }
                // v3 added the track metadata index; older files rebuild it
                // from what they still carry (liked + history).
                if d.version < 3 {
                    d.backfill_track_index();
                    d.version = LIBRARY_FORMAT_VERSION;
                }
                (d, false)
            }
            Ok(None) => (LibraryData::new(), false),
            Err(err) => {
                let backup = path.with_extension("json.corrupt");
                let _ = std::fs::rename(
                    path,
                    &backup,
                );
                eprintln!("[melo] library file was corrupt ({err}); backed up to {}", backup.display());
                (LibraryData::new(), true)
            }
        };
        let _ = recovered;
        let store = Self { path: path.to_path_buf(), data: Mutex::new(data) };
        let _ = store.save();
        store
    }

    pub fn snapshot(&self) -> LibraryData {
        self.data
            .lock()
            .map(|d| d.clone())
            .unwrap_or_default()
    }

    /// Mutate + persist under one lock. The caller gets the return value of
    /// `f`; IO errors are logged, not fatal.
    pub fn with_mut<R>(&self, f: impl FnOnce(&mut LibraryData) -> R) -> R {
        let result = {
            let mut guard = self.data.lock().unwrap_or_else(|p| p.into_inner());
            f(&mut guard)
        };
        if let Err(err) = self.save() {
            eprintln!("[melo] library save failed: {err}");
        }
        result
    }

    fn save(&self) -> Result<(), String> {
        let data = self
            .data
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        save_json_atomic(&self.path, &data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ArtistRef, TrackSource};

    fn track(n: u32) -> Track {
        Track {
            id: format!("t:{n}"),
            source: TrackSource::YouTube,
            source_id: format!("v{n}"),
            title: format!("Track {n}"),
            artists: vec![ArtistRef { id: "ytart:a".into(), name: "Artist".into() }],
            album: Some(crate::domain::AlbumRef { id: "ytalb:x".into(), title: "Album X".into() }),
            duration_secs: Some(180.0),
            artwork: None,
            is_local: false,
            metadata: Default::default(),
        }
    }

    #[test]
    fn like_toggle_is_instant_and_ordered_newest_first() {
        let mut lib = LibraryData::new();
        assert!(lib.toggle_like(&track(1)));
        assert!(lib.toggle_like(&track(2)));
        assert!(lib.is_liked("t:1"));
        assert_eq!(lib.liked[0].id, "t:2"); // newest first
        assert!(!lib.toggle_like(&track(1)));
        assert!(!lib.is_liked("t:1"));
    }

    #[test]
    fn playlist_crud_and_counts() {
        let mut lib = LibraryData::new();
        let pl = lib.create_playlist("Road trip", None);
        assert!(lib.playlist_add_tracks(&pl.id, &[track(1), track(2), track(3)]));
        assert_eq!(lib.playlist(&pl.id).unwrap().track_count, 3);
        assert!(lib.playlist_remove_at(&pl.id, 0));
        assert_eq!(lib.playlist_track_ids(&pl.id), vec!["t:2".to_string(), "t:3".to_string()]);
        // positions renumbered
        let rows = lib.playlist_tracks.get(&pl.id).unwrap();
        assert_eq!(rows[0].position, 0);
        assert_eq!(rows[1].position, 1);
        assert!(lib.playlist_reorder(&pl.id, 1, 0));
        assert_eq!(lib.playlist_track_ids(&pl.id), vec!["t:3".to_string(), "t:2".to_string()]);
        lib.assert_invariants().unwrap();
        assert!(lib.rename_playlist(&pl.id, "Night drive"));
        assert_eq!(lib.playlist(&pl.id).unwrap().title, "Night drive");
        assert!(!lib.rename_playlist(&pl.id, "   "));
        assert!(lib.delete_playlist(&pl.id));
        assert!(lib.playlist_tracks.get(&pl.id).is_none());
        assert!(!lib.delete_playlist(&pl.id));
        lib.assert_invariants().unwrap();
    }

    #[test]
    fn duplicate_playlist_copies_tracks_independently() {
        let mut lib = LibraryData::new();
        let pl = lib.create_playlist("Original", None);
        lib.playlist_add_tracks(&pl.id, &[track(1), track(2)]);
        let copy = lib.duplicate_playlist(&pl.id, "Copy").unwrap();
        assert_ne!(copy.id, pl.id);
        assert_eq!(copy.track_count, 2);
        lib.playlist_remove_at(&pl.id, 0);
        assert_eq!(lib.playlist_track_ids(&copy.id).len(), 2);
        lib.assert_invariants().unwrap();
    }

    #[test]
    fn history_records_finalizes_and_dedupes() {
        let mut lib = LibraryData::new();
        let t1 = track(1);
        assert!(lib.record_play(&t1, 1_000));
        // Same track replayed 10s later collapses (repeat-one).
        assert!(!lib.record_play(&t1, 11_000));
        assert!(lib.record_play(&track(2), 12_000));
        assert_eq!(lib.history.len(), 2);
        assert!(lib.finish_recent_for("t:1", 175.0, 0.97));
        let entry = lib.history.iter().find(|h| h.track.id == "t:1").unwrap();
        assert_eq!(entry.played_secs, 175.0);
        assert!((entry.completion - 0.97).abs() < 1e-9);
        // Recent tracks are distinct, newest first.
        let recent = lib.recently_played(10);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].id, "t:2");
        // A later replay of t1 DOES create a new entry (past the window).
        assert!(lib.record_play(&t1, 60_000));
        assert_eq!(lib.history.len(), 3);
        let recent = lib.recently_played(10);
        assert_eq!(recent[0].id, "t:1");
        assert_eq!(recent.len(), 2); // still distinct
    }

    #[test]
    fn history_is_capped() {
        let mut lib = LibraryData::new();
        for n in 0..(HISTORY_CAP as u32 + 50) {
            lib.record_play(&track(n), (n as u64) * 60_000);
        }
        assert_eq!(lib.history.len(), HISTORY_CAP);
        // Newest survived.
        assert_eq!(lib.history[0].track.id, format!("t:{}", HISTORY_CAP + 49));
    }

    #[test]
    fn search_history_dedupes_moves_and_caps() {
        let mut lib = LibraryData::new();
        for q in ["a", "b", "c", "d", "e"] {
            lib.push_search(q);
        }
        lib.push_search("b"); // move to front, no duplicate
        assert_eq!(lib.search_history.first().unwrap(), "b");
        assert_eq!(lib.search_history.len(), 5);
        lib.remove_search("b");
        assert!(!lib.search_history.contains(&"b".to_string()));
        lib.clear_search_history();
        assert!(lib.search_history.is_empty());
        lib.push_search("   "); // blank ignored
        assert!(lib.search_history.is_empty());
        for i in 0..(SEARCH_HISTORY_CAP as u32 + 5) {
            lib.push_search(&format!("q{i}"));
        }
        assert_eq!(lib.search_history.len(), SEARCH_HISTORY_CAP);
    }

    #[test]
    fn store_roundtrip_and_corruption_recovery() {
        let dir = std::env::temp_dir().join(format!("melo-libtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.json");

        let store = LibraryStore::open(&path);
        let pl = store.with_mut(|l| l.create_playlist("Persisted", None));
        store.with_mut(|l| l.playlist_add_tracks(&pl.id, &[track(1), track(2)]));
        store.with_mut(|l| {
            l.toggle_like(&track(9));
            l.record_play(&track(1), 123);
        });

        let reopened = LibraryStore::open(&path);
        let snap = reopened.snapshot();
        assert_eq!(snap.liked.len(), 1);
        assert_eq!(snap.playlists.len(), 1);
        assert_eq!(snap.playlist_track_ids(&pl.id).len(), 2);
        assert_eq!(snap.history.len(), 1);
        snap.assert_invariants().unwrap();

        // Corrupt the file → recovery with backup, fresh library.
        std::fs::write(&path, "{ not json").unwrap();
        let recovered = LibraryStore::open(&path);
        assert_eq!(recovered.snapshot().liked.len(), 0);
        assert!(path.with_extension("json.corrupt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_v1_document_loads_with_defaults() {
        // A v1-shaped document (no version, no searchHistory, no
        // playlistTracks rows) must load and be re-saved at the current
        // version — serde default-filling is the migration.
        let v1 = serde_json::json!({
            "liked": [track(1)],
            "playlists": [{
                "id": "pl:old",
                "kind": "manual",
                "title": "Old",
                "isFolder": false,
                "trackCount": 0
            }],
            "history": []
        });
        let lib: LibraryData = serde_json::from_value(v1).unwrap();
        assert_eq!(lib.version, 0);
        assert_eq!(lib.liked.len(), 1);
        assert!(lib.search_history.is_empty());
        let mut lib = lib;
        lib.version = LIBRARY_FORMAT_VERSION;
        lib.assert_invariants().unwrap();
    }

    #[test]
    fn unknown_future_fields_are_preserved_by_ignoring() {
        // Forward compatibility: unknown fields must not break loading.
        let future = serde_json::json!({
            "version": 99,
            "liked": [],
            "playlists": [],
            "playlistTracks": {},
            "history": [],
            "searchHistory": ["x"],
            "someFutureField": {"nested": true}
        });
        let lib: LibraryData = serde_json::from_value(future).unwrap();
        assert_eq!(lib.search_history, vec!["x".to_string()]);
    }

    #[test]
    fn playlist_tracks_resolve_without_play_or_like() {
        // v3: adding a search result to a playlist must be enough for the
        // playlist to play it back later — the metadata index remembers it.
        let mut lib = LibraryData::new();
        let pl = lib.create_playlist("From search", None);
        assert!(lib.playlist_add_tracks(&pl.id, &[track(42)]));
        assert_eq!(lib.playlist_track_ids(&pl.id), vec!["t:42".to_string()]);
        assert_eq!(lib.track_by_id("t:42").unwrap().title, "Track 42");
    }

    #[test]
    fn backfill_rebuilds_index_from_liked_and_history() {
        let mut lib = LibraryData::new();
        assert!(lib.toggle_like(&track(1)));
        assert!(lib.record_play(&track(2), 1_000));
        // Simulate a v2 file: index dropped, collections intact.
        lib.tracks.clear();
        assert!(lib.track_by_id("t:1").is_some()); // liked still resolves
        lib.backfill_track_index();
        assert!(lib.track_by_id("t:1").is_some());
        assert!(lib.track_by_id("t:2").is_some());
    }
}
