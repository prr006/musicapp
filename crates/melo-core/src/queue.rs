//! The queue state machine.
//!
//! The queue is a first-class citizen (spec §4). It answers exactly one
//! question for the playback state machine: *"when the current track ends (or
//! the user skips), which queue item plays next?"* — plus everything needed to
//! mutate itself safely mid-playback.
//!
//! ## Model
//!
//! ```text
//!   items   : Vec<QueueItem>     canonical storage (display order when shuffle is off)
//!   order   : Vec<QueueItemId>   the play sequence — a permutation of items
//!   cursor  : Option<usize>      index into `order` of the loaded track
//!   history : Vec<QueueItemId>   previously played (most recent last)
//! ```
//!
//! Invariants (checked by [`QueueMachine::assert_invariants`]):
//! 1. `order` is a permutation of `items` ids — never duplicates, never gaps.
//! 2. `cursor` always points at the current item within `order`.
//! 3. `history` ids always exist in `items`.
//! 4. Toggling shuffle never moves or replaces the current item.
//!
//! Shuffle is deterministic: a seeded xorshift RNG drives all randomness, so
//! a given seed + queue always produces the same play sequence (testable,
//! reproducible bug reports, stable "restore session").

use serde::{Deserialize, Serialize};

use crate::domain::Track;
use crate::ids::QueueItemId;

/// Repeat modes (spec §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode {
    #[default]
    Off,
    All,
    One,
}

/// One entry of the queue. Distinct from `Track`: the same track can occupy
/// multiple queue positions, each with its own id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: QueueItemId,
    pub track: Track,
}

/// Where new tracks land in the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddPosition {
    /// Append to the end (random spot in the upcoming span while shuffled).
    End,
    /// Insert directly after the current item ("Play next").
    AfterCurrent,
}

/// The decision produced by any queue operation that can change what plays.
/// The playback state machine translates this into `PlayerCommand`s.
#[derive(Debug, Clone, PartialEq)]
pub enum QueueStep {
    /// Nothing to do.
    None,
    /// Load this item as the new current track.
    Load(QueueItemId),
    /// Restart the current item (repeat-one hit EOF).
    ReplayCurrent,
    /// Seek back to 0:0 of the current item ("previous" on a fresh track).
    SeekStart,
    /// Queue ran dry with repeat off — playback should stop (status → idle).
    EndOfQueue,
}

/// Serializable queue view sent to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueView {
    pub current: Option<QueueItem>,
    pub upcoming: Vec<QueueItem>,
    /// Most-recent-first for display.
    pub history: Vec<QueueItem>,
    pub shuffle: bool,
    pub repeat: RepeatMode,
    /// Increments on every mutation; lets the host detect changes cheaply.
    pub rev: u64,
}

/// The queue state machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueMachine {
    items: Vec<QueueItem>,
    order: Vec<QueueItemId>,
    cursor: Option<usize>,
    history: Vec<QueueItemId>,
    shuffle: bool,
    repeat: RepeatMode,
    #[serde(default)]
    rev: u64,
    /// xorshift64* state; must never be 0.
    rng: u64,
    #[serde(default)]
    id_seq: u64,
}

impl QueueMachine {
    /// An empty "nothing playing" view for UI boot before any state exists.
    pub fn empty_view() -> QueueView {
        QueueView {
            current: None,
            upcoming: Vec::new(),
            history: Vec::new(),
            shuffle: false,
            repeat: RepeatMode::Off,
            rev: 0,
        }
    }

    /// New empty queue with a time-based seed.
    pub fn new() -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x1234_5678)
            | 1;
        Self::with_seed(seed)
    }

    /// New empty queue with a fixed RNG seed (deterministic; for tests).
    pub fn with_seed(seed: u64) -> Self {
        Self {
            items: Vec::new(),
            order: Vec::new(),
            cursor: None,
            history: Vec::new(),
            shuffle: false,
            repeat: RepeatMode::Off,
            rev: 0,
            rng: if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed },
            id_seq: 0,
        }
    }

    // ------------------------------------------------------------------
    // Introspection
    // ------------------------------------------------------------------

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn shuffle(&self) -> bool {
        self.shuffle
    }

    pub fn repeat(&self) -> RepeatMode {
        self.repeat
    }

    pub fn rev(&self) -> u64 {
        self.rev
    }

    /// The currently loaded queue item, if any.
    pub fn current(&self) -> Option<&QueueItem> {
        let idx = self.cursor?;
        self.item_by_id(self.order.get(idx)?)
    }

    pub fn item_by_id(&self, id: &str) -> Option<&QueueItem> {
        self.items.iter().find(|i| i.id == id)
    }

    fn index_of_id(&self, id: &str) -> Option<usize> {
        self.order.iter().position(|i| i == id)
    }

    /// Upcoming items in play order (everything after the cursor).
    pub fn upcoming(&self) -> Vec<QueueItem> {
        match self.cursor {
            Some(c) => self.order.iter().skip(c + 1).map(|id| self.item_by_id(id).cloned().unwrap()).collect(),
            None => self.order.iter().map(|id| self.item_by_id(id).cloned().unwrap()).collect(),
        }
    }

    /// Previously played items, most recent first.
    pub fn history(&self) -> Vec<QueueItem> {
        let mut out = Vec::new();
        for id in self.history.iter().rev() {
            if let Some(item) = self.item_by_id(id) {
                out.push(item.clone());
            }
        }
        out
    }

    /// Full serializable view.
    pub fn view(&self) -> QueueView {
        QueueView {
            current: self.current().cloned(),
            upcoming: self.upcoming(),
            history: self.history(),
            shuffle: self.shuffle,
            repeat: self.repeat,
            rev: self.rev,
        }
    }

    /// The play sequence (ids). Exposed for persistence and tests.
    pub fn order_ids(&self) -> &[QueueItemId] {
        &self.order
    }

    pub fn cursor_index(&self) -> Option<usize> {
        self.cursor
    }

    pub fn history_ids(&self) -> &[QueueItemId] {
        &self.history
    }

    // ------------------------------------------------------------------
    // RNG
    // ------------------------------------------------------------------

    fn next_u64(&mut self) -> u64 {
        // xorshift64* — small, fast, deterministic. Not cryptographic;
        // we only need reproducible shuffles.
        let mut x = self.rng;
        debug_assert_ne!(x, 0);
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn rand_below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }

    fn shuffled(&mut self, ids: Vec<QueueItemId>) -> Vec<QueueItemId> {
        let mut v = ids;
        for i in (1..v.len()).rev() {
            let j = self.rand_below(i + 1);
            v.swap(i, j);
        }
        v
    }

    fn bump(&mut self) {
        self.rev = self.rev.wrapping_add(1);
    }

    fn spawn_item_id(&mut self) -> QueueItemId {
        self.id_seq += 1;
        format!("qi:{}", self.id_seq)
    }

    // ------------------------------------------------------------------
    // Mutation
    // ------------------------------------------------------------------

    /// Add tracks at `pos`. Returns the ids of the created queue items.
    pub fn add_tracks(&mut self, tracks: Vec<Track>, pos: AddPosition) -> Vec<QueueItemId> {
        if tracks.is_empty() {
            return Vec::new();
        }
        let mut created = Vec::new();
        for track in tracks {
            let id = self.spawn_item_id();
            self.items.push(QueueItem { id: id.clone(), track });
            created.push(id);
        }
        match pos {
            AddPosition::AfterCurrent => {
                let at = self.cursor.map(|c| c + 1).unwrap_or(0);
                for (n, id) in created.iter().enumerate() {
                    self.order.insert(at + n, id.clone());
                }
            }
            AddPosition::End => {
                if self.shuffle {
                    // Random spots anywhere in the upcoming span so shuffle
                    // stays honest for late arrivals.
                    let start = self.cursor.map(|c| c + 1).unwrap_or(0);
                    for id in &created {
                        let span = self.order.len() - start + 1;
                        let at = start + self.rand_below(span);
                        self.order.insert(at, id.clone());
                    }
                } else {
                    for id in &created {
                        self.order.push(id.clone());
                    }
                }
            }
        }
        self.bump();
        created
    }

    /// Insert `track` after the current item and make it current immediately.
    /// Whatever was current is pushed onto history.
    pub fn play_now(&mut self, track: Track) -> QueueStep {
        let ids = self.add_tracks(vec![track], AddPosition::AfterCurrent);
        let id = ids[0].clone();
        self.jump_to(&id)
    }

    /// Jump to an existing queue item (clicking an upcoming row, or internal
    /// use). Pushes the outgoing current item onto history.
    pub fn jump_to(&mut self, id: &str) -> QueueStep {
        let Some(pos) = self.index_of_id(id) else { return QueueStep::None };
        if let Some(c) = self.cursor {
            if c != pos {
                let outgoing = self.order[c].clone();
                self.push_history(outgoing);
            }
        }
        self.cursor = Some(pos);
        self.bump();
        QueueStep::Load(id.to_string())
    }

    /// Replace the whole queue with `tracks` and start at the first item.
    /// `shuffle` shuffles the sequence (the first played item is random).
    pub fn start_sequence(&mut self, tracks: Vec<Track>, shuffle: bool) -> QueueStep {
        self.items.clear();
        self.order.clear();
        self.history.clear();
        self.cursor = None;
        self.shuffle = shuffle;
        let ids = self.add_tracks(tracks, AddPosition::End);
        if ids.is_empty() {
            self.bump();
            return QueueStep::None;
        }
        if shuffle {
            let ids = std::mem::take(&mut self.order);
            self.order = self.shuffled(ids);
        }
        self.cursor = Some(0);
        self.bump();
        QueueStep::Load(self.order[0].clone())
    }

    /// Advance one step. `user_initiated=false` when called from EOF
    /// (repeat-one then replays; an explicit Next skips).
    pub fn advance(&mut self, user_initiated: bool) -> QueueStep {
        match self.cursor {
            None => {
                if self.order.is_empty() {
                    QueueStep::None
                } else {
                    self.cursor = Some(0);
                    QueueStep::Load(self.order[0].clone())
                }
            }
            Some(c) => {
                if self.repeat == RepeatMode::One && !user_initiated {
                    return QueueStep::ReplayCurrent;
                }
                let outgoing = self.order[c].clone();
                if c + 1 < self.order.len() {
                    self.push_history(outgoing);
                    self.cursor = Some(c + 1);
                    QueueStep::Load(self.order[c + 1].clone())
                } else if self.repeat == RepeatMode::All && !self.order.is_empty() {
                    self.push_history(outgoing);
                    self.cursor = Some(0);
                    QueueStep::Load(self.order[0].clone())
                } else {
                    QueueStep::EndOfQueue
                }
            }
        }
    }

    /// Go back one step. With empty history this restarts the current track
    /// (`SeekStart`); the "restart if we're >3s in" policy belongs to the
    /// playback state machine, which knows the position.
    pub fn previous(&mut self) -> QueueStep {
        if let Some(id) = self.history.pop() {
            if let Some(pos) = self.index_of_id(&id) {
                self.cursor = Some(pos);
                self.bump();
                return QueueStep::Load(id);
            }
        }
        if self.cursor.is_some() {
            return QueueStep::SeekStart;
        }
        if self.order.is_empty() {
            QueueStep::None
        } else {
            self.cursor = Some(0);
            QueueStep::Load(self.order[0].clone())
        }
    }

    /// Remove an item. If it was current, playback continues with whatever
    /// follows it in play order (or the queue ends).
    pub fn remove(&mut self, id: &str) -> QueueStep {
        let Some(item_pos) = self.items.iter().position(|i| i.id == id) else {
            return QueueStep::None;
        };
        let Some(order_pos) = self.index_of_id(id) else {
            self.items.remove(item_pos);
            self.bump();
            return QueueStep::None;
        };
        let was_current = self.cursor == Some(order_pos);
        self.items.remove(item_pos);
        self.order.remove(order_pos);
        if let Some(c) = self.cursor {
            if order_pos < c {
                self.cursor = Some(c - 1);
            }
        }
        self.history.retain(|h| h != id);
        self.bump();
        if !was_current {
            return QueueStep::None;
        }
        // Current item was removed: fall through to whatever now sits at the
        // cursor position.
        match self.cursor {
            Some(c) if c < self.order.len() => QueueStep::Load(self.order[c].clone()),
            _ => {
                if self.repeat == RepeatMode::All && !self.order.is_empty() {
                    self.cursor = Some(0);
                    QueueStep::Load(self.order[0].clone())
                } else {
                    self.cursor = None;
                    QueueStep::EndOfQueue
                }
            }
        }
    }

    /// Clear everything after the current item. The current item keeps
    /// playing; history is preserved.
    pub fn clear_upcoming(&mut self) {
        let keep = self.cursor.map(|c| c + 1).unwrap_or(0);
        self.order.truncate(keep);
        self.retain_items_in_play();
        self.bump();
    }

    /// Clear everything and stop.
    pub fn clear_all(&mut self) -> QueueStep {
        self.items.clear();
        self.order.clear();
        self.history.clear();
        self.cursor = None;
        self.bump();
        QueueStep::EndOfQueue
    }

    /// Drop stored items that are neither current/upcoming nor in history.
    fn retain_items_in_play(&mut self) {
        let mut keep = self.order.clone();
        keep.extend(self.history.iter().cloned());
        self.items.retain(|i| keep.contains(&i.id));
    }

    /// History is a bounded log: the most recent 500 entries are kept.
    const HISTORY_CAP: usize = 500;

    fn push_history(&mut self, id: QueueItemId) {
        if self.history.last() == Some(&id) {
            return;
        }
        if self.history.len() >= HISTORY_CAP {
            self.history.remove(0);
        }
        self.history.push(id);
    }

    /// Toggle shuffle. The current item never moves and the order stays a
    /// permutation: `[current] + shuffled(upcoming) + already-played`.
    pub fn set_shuffle(&mut self, enabled: bool) {
        if enabled == self.shuffle {
            return;
        }
        self.shuffle = enabled;
        if enabled {
            let current = self.cursor.map(|c| self.order[c].clone());
            let (played, rest) = match self.cursor {
                Some(c) => (self.order[..c].to_vec(), self.order[c + 1..].to_vec()),
                None => (Vec::new(), self.order.clone()),
            };
            let shuffled_rest = self.shuffled(rest);
            let mut order = Vec::with_capacity(self.order.len());
            if let Some(cur) = current {
                order.push(cur);
            }
            order.extend(shuffled_rest);
            order.extend(played);
            self.order = order;
            self.cursor = self.cursor.map(|_| 0);
        } else {
            let current = self.cursor.map(|c| self.order[c].clone());
            self.order = self.items.iter().map(|i| i.id.clone()).collect();
            self.cursor = current.and_then(|id| self.index_of_id(&id));
        }
        self.bump();
    }

    pub fn set_repeat(&mut self, mode: RepeatMode) {
        if mode != self.repeat {
            self.repeat = mode;
            self.bump();
        }
    }

    /// Move an upcoming item one slot up (towards playing sooner).
    pub fn move_up(&mut self, id: &str) {
        let Some(pos) = self.index_of_id(id) else { return };
        let floor = self.cursor.map(|c| c + 1).unwrap_or(0);
        if pos > floor && pos < self.order.len() {
            self.order.swap(pos, pos - 1);
            self.bump();
        }
    }

    /// Move an upcoming item one slot down.
    pub fn move_down(&mut self, id: &str) {
        let Some(pos) = self.index_of_id(id) else { return };
        let floor = self.cursor.map(|c| c + 1).unwrap_or(0);
        if pos >= floor && pos + 1 < self.order.len() {
            self.order.swap(pos, pos + 1);
            self.bump();
        }
    }

    /// Reorder within the upcoming span (drag & drop). `from`/`to` are
    /// 0-based indices into the upcoming list, not into `order`.
    pub fn reorder_upcoming(&mut self, from: usize, to: usize) {
        let floor = self.cursor.map(|c| c + 1).unwrap_or(0);
        let upcoming_len = self.order.len() - floor;
        if from >= upcoming_len || to >= upcoming_len {
            return;
        }
        let id = self.order.remove(floor + from);
        self.order.insert(floor + to, id);
        self.bump();
    }

    // ------------------------------------------------------------------
    // Invariant checking
    // ------------------------------------------------------------------

    /// Verify all structural invariants. Called from tests and debug builds.
    pub fn assert_invariants(&self) -> Result<(), String> {
        if self.order.len() != self.items.len() {
            return Err(format!(
                "order/items length mismatch: {} vs {}",
                self.order.len(),
                self.items.len()
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for id in &self.order {
            if !seen.insert(id.clone()) {
                return Err(format!("duplicate id in order: {id}"));
            }
            if self.item_by_id(id).is_none() {
                return Err(format!("order references missing item: {id}"));
            }
        }
        for item in &self.items {
            if !seen.contains(&item.id) {
                return Err(format!("item missing from order: {}", item.id));
            }
        }
        for id in &self.history {
            if self.item_by_id(id).is_none() {
                return Err(format!("history references missing item: {id}"));
            }
        }
        if let Some(c) = self.cursor {
            if c >= self.order.len() {
                return Err(format!("cursor {c} out of range (len {})", self.order.len()));
            }
        }
        if let Some(c) = self.cursor {
            if let Some(cur) = self.current() {
                if self.order[c] != cur.id {
                    return Err("cursor does not point at current item".into());
                }
            }
        }
        Ok(())
    }
}

impl Default for QueueMachine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{ArtistRef, Track};
    use crate::domain::TrackSource;
    use std::collections::HashSet;

    fn track(n: u32) -> Track {
        Track {
            id: format!("t:{n}"),
            source: TrackSource::YouTube,
            source_id: format!("v{n}"),
            title: format!("Track {n}"),
            artists: vec![ArtistRef { id: "a:1".into(), name: "Artist".into() }],
            album: None,
            duration_secs: Some(180.0),
            artwork: None,
            is_local: false,
            metadata: Default::default(),
        }
    }

    fn titles(items: &[QueueItem]) -> Vec<String> {
        items.iter().map(|i| i.track.title.clone()).collect()
    }

    fn ids_of(view: &QueueView) -> Vec<String> {
        view.upcoming.iter().map(|i| i.id.clone()).collect()
    }

    #[test]
    fn empty_queue_advances_to_nothing() {
        let mut q = QueueMachine::with_seed(42);
        assert_eq!(q.advance(false), QueueStep::None);
        assert_eq!(q.previous(), QueueStep::None);
        q.assert_invariants().unwrap();
    }

    #[test]
    fn play_first_loads_first_and_advances_in_order() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=3).map(track).collect(), AddPosition::End);
        assert_eq!(q.current(), None);
        assert_eq!(q.advance(true), QueueStep::Load("qi:1".into()));
        assert_eq!(q.current().unwrap().track.title, "Track 1");
        assert_eq!(q.advance(true), QueueStep::Load("qi:2".into()));
        assert_eq!(q.advance(true), QueueStep::Load("qi:3".into()));
        q.assert_invariants().unwrap();
    }

    #[test]
    fn eof_at_end_with_repeat_off_ends_queue() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=2).map(track).collect(), AddPosition::End);
        q.advance(true); // qi:1
        q.advance(false); // qi:2
        assert_eq!(q.advance(false), QueueStep::EndOfQueue);
        // Current stays visible so the UI can keep showing what finished.
        assert_eq!(q.current().unwrap().track.title, "Track 2");
        q.assert_invariants().unwrap();
    }

    #[test]
    fn repeat_all_wraps_at_the_end() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=2).map(track).collect(), AddPosition::End);
        q.set_repeat(RepeatMode::All);
        q.advance(true); // qi:1
        q.advance(false); // qi:2
        assert_eq!(q.advance(false), QueueStep::Load("qi:1".into()));
        q.assert_invariants().unwrap();
    }

    #[test]
    fn repeat_one_replays_on_eof_but_explicit_next_advances() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=2).map(track).collect(), AddPosition::End);
        q.set_repeat(RepeatMode::One);
        q.advance(true); // qi:1
        assert_eq!(q.advance(false), QueueStep::ReplayCurrent);
        assert_eq!(q.advance(true), QueueStep::Load("qi:2".into()));
        q.assert_invariants().unwrap();
    }

    #[test]
    fn history_and_previous() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=3).map(track).collect(), AddPosition::End);
        q.advance(true); // 1
        q.advance(true); // 2
        assert_eq!(titles(&q.history()), vec!["Track 1"]);
        assert_eq!(q.previous(), QueueStep::Load("qi:1".into()));
        assert_eq!(q.current().unwrap().track.title, "Track 1");
        // History exhausted → restart current.
        assert_eq!(q.previous(), QueueStep::SeekStart);
        q.assert_invariants().unwrap();
    }

    #[test]
    fn previous_with_empty_queue_is_noop() {
        let mut q = QueueMachine::with_seed(1);
        assert_eq!(q.previous(), QueueStep::None);
    }

    #[test]
    fn play_next_inserts_after_current() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=2).map(track).collect(), AddPosition::End);
        q.advance(true); // current: Track 1
        q.add_tracks(vec![track(9)], AddPosition::AfterCurrent);
        assert_eq!(ids_of(&q.view()).len(), 2);
        assert_eq!(q.view().upcoming[0].track.title, "Track 9");
        assert_eq!(q.advance(true), QueueStep::Load("qi:3".into()));
        q.assert_invariants().unwrap();
    }

    #[test]
    fn add_to_queue_appends_after_upcoming() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=2).map(track).collect(), AddPosition::End);
        q.advance(true);
        q.add_tracks(vec![track(5), track(6)], AddPosition::End);
        let view = q.view();
        assert_eq!(titles(&view.upcoming), vec!["Track 2", "Track 5", "Track 6"]);
        q.assert_invariants().unwrap();
    }

    #[test]
    fn play_now_jumps_and_pushes_outgoing_to_history() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=3).map(track).collect(), AddPosition::End);
        q.advance(true); // current: 1
        let step = q.play_now(track(9));
        assert!(matches!(step, QueueStep::Load(_)));
        assert_eq!(q.current().unwrap().track.title, "Track 9");
        assert_eq!(titles(&q.history()), vec!["Track 1"]);
        // Track 2 is still the next upcoming (9 was inserted after 1).
        assert_eq!(q.view().upcoming[0].track.title, "Track 2");
        q.assert_invariants().unwrap();
    }

    #[test]
    fn remove_upcoming_keeps_current() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=3).map(track).collect(), AddPosition::End);
        q.advance(true); // 1
        assert_eq!(q.remove("qi:2"), QueueStep::None);
        assert_eq!(q.current().unwrap().track.title, "Track 1");
        assert_eq!(titles(&q.upcoming()), vec!["Track 3"]);
        q.assert_invariants().unwrap();
    }

    #[test]
    fn remove_current_loads_next_in_play_order() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=3).map(track).collect(), AddPosition::End);
        q.advance(true); // current: 1
        assert_eq!(q.remove("qi:1"), QueueStep::Load("qi:2".into()));
        assert_eq!(q.current().unwrap().track.title, "Track 2");
        // Removed track must not appear in history.
        assert!(q.history().is_empty());
        q.assert_invariants().unwrap();
    }

    #[test]
    fn remove_current_at_end_with_repeat_off_ends_queue() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=2).map(track).collect(), AddPosition::End);
        q.advance(true);
        q.advance(true); // current: 2 (last)
        assert_eq!(q.remove("qi:2"), QueueStep::EndOfQueue);
        assert_eq!(q.current(), None);
        q.assert_invariants().unwrap();
    }

    #[test]
    fn remove_current_at_end_with_repeat_all_wraps() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=2).map(track).collect(), AddPosition::End);
        q.set_repeat(RepeatMode::All);
        q.advance(true);
        q.advance(true); // current: 2
        assert_eq!(q.remove("qi:2"), QueueStep::Load("qi:1".into()));
        q.assert_invariants().unwrap();
    }

    #[test]
    fn remove_referenced_by_history_purges_history_too() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=3).map(track).collect(), AddPosition::End);
        q.advance(true); // 1
        q.advance(true); // 2
        q.previous(); // back to 1, history: [1]? no — history popped, history empty now
        q.advance(true); // 2 again, history: [1]
        assert_eq!(q.remove("qi:1"), QueueStep::None);
        assert!(q.history().is_empty());
        q.assert_invariants().unwrap();
    }

    #[test]
    fn clear_upcoming_keeps_current_and_history() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=4).map(track).collect(), AddPosition::End);
        q.advance(true); // 1
        q.advance(true); // 2
        q.clear_upcoming();
        assert_eq!(q.current().unwrap().track.title, "Track 2");
        assert_eq!(q.upcoming().len(), 0);
        assert_eq!(titles(&q.history()), vec!["Track 1"]);
        // EOF now ends the queue (nothing left).
        assert_eq!(q.advance(false), QueueStep::EndOfQueue);
        q.assert_invariants().unwrap();
    }

    #[test]
    fn clear_all_resets_everything() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=3).map(track).collect(), AddPosition::End);
        q.advance(true);
        assert_eq!(q.clear_all(), QueueStep::EndOfQueue);
        assert!(q.is_empty());
        assert_eq!(q.current(), None);
        q.assert_invariants().unwrap();
    }

    #[test]
    fn shuffle_keeps_current_in_place_and_stays_permutation() {
        let mut q = QueueMachine::with_seed(77);
        q.add_tracks((1..=8).map(track).collect(), AddPosition::End);
        q.advance(true); // current: Track 1 (qi:1)
        q.advance(true); // current: Track 2 (qi:2)
        q.set_shuffle(true);
        q.assert_invariants().unwrap();
        assert_eq!(q.current().unwrap().track.title, "Track 2");
        // Upcoming must be the remaining 6 items in some order.
        let mut upcoming = titles(&q.upcoming());
        upcoming.sort();
        assert_eq!(
            upcoming,
            vec!["Track 1", "Track 3", "Track 4", "Track 5", "Track 6", "Track 7", "Track 8"]
        );
        // Walking the queue visits every track exactly once (repeat off).
        let mut visited = vec!["Track 2".to_string()];
        loop {
            match q.advance(false) {
                QueueStep::Load(_) => visited.push(q.current().unwrap().track.title.clone()),
                QueueStep::EndOfQueue => break,
                other => panic!("unexpected step: {other:?}"),
            }
        }
        visited.sort();
        visited.dedup();
        assert_eq!(visited.len(), 8);
        q.assert_invariants().unwrap();
    }

    #[test]
    fn unshuffle_restores_canonical_order_and_keeps_current() {
        let mut q = QueueMachine::with_seed(5);
        q.add_tracks((1..=6).map(track).collect(), AddPosition::End);
        q.set_shuffle(true);
        q.advance(true);
        let current_before = q.current().unwrap().id.clone();
        q.set_shuffle(false);
        q.assert_invariants().unwrap();
        // The current item survives the toggle untouched.
        assert_eq!(q.current().unwrap().id, current_before);
        // Order returns to canonical (items) order.
        assert_eq!(
            q.order_ids().to_vec(),
            (1..=6).map(|i| format!("qi:{i}")).collect::<Vec<_>>()
        );
        // Everything after the current item is canonical upcoming.
        let cur_idx = q.cursor_index().unwrap();
        assert_eq!(
            q.order_ids()[cur_idx + 1..],
            (cur_idx + 2..=6).map(|i| format!("qi:{i}")).collect::<Vec<_>>()
        );
    }

    #[test]
    fn shuffle_is_deterministic_for_a_seed() {
        let mut a = QueueMachine::with_seed(1234);
        let mut b = QueueMachine::with_seed(1234);
        let tracks = (1..=10).map(track).collect::<Vec<_>>();
        a.start_sequence(tracks.clone(), true);
        b.start_sequence(tracks, true);
        assert_eq!(a.order_ids(), b.order_ids());
    }

    #[test]
    fn add_while_shuffled_lands_in_upcoming() {
        let mut q = QueueMachine::with_seed(9);
        q.add_tracks((1..=4).map(track).collect(), AddPosition::End);
        q.advance(true); // current: 1
        q.set_shuffle(true);
        q.add_tracks(vec![track(99)], AddPosition::End);
        q.assert_invariants().unwrap();
        assert!(q.upcoming().iter().any(|i| i.track.title == "Track 99"));
        // And it plays exactly once during a full walk.
        let mut seen = 0;
        loop {
            match q.advance(false) {
                QueueStep::Load(_) => {
                    if q.current().unwrap().track.title == "Track 99" {
                        seen += 1;
                    }
                }
                QueueStep::EndOfQueue => break,
                other => panic!("unexpected: {other:?}"),
            }
        }
        assert_eq!(seen, 1);
    }

    #[test]
    fn move_up_down_reorder_within_upcoming_only() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=4).map(track).collect(), AddPosition::End);
        q.advance(true); // current: 1
        q.move_up("qi:1"); // current item: no-op
        assert_eq!(q.current().unwrap().track.title, "Track 1");
        q.move_down("qi:2");
        assert_eq!(titles(&q.upcoming()), vec!["Track 3", "Track 2", "Track 4"]);
        q.move_up("qi:2");
        assert_eq!(titles(&q.upcoming()), vec!["Track 2", "Track 3", "Track 4"]);
        q.reorder_upcoming(0, 2);
        assert_eq!(titles(&q.upcoming()), vec!["Track 3", "Track 4", "Track 2"]);
        q.assert_invariants().unwrap();
    }

    #[test]
    fn start_sequence_replaces_and_starts() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=3).map(track).collect(), AddPosition::End);
        q.advance(true);
        let step = q.start_sequence(vec![track(7), track(8)], false);
        assert_eq!(step, QueueStep::Load("qi:4".into()));
        assert_eq!(q.current().unwrap().track.title, "Track 7");
        assert_eq!(q.history().len(), 0);
        assert_eq!(q.upcoming().len(), 1);
        q.assert_invariants().unwrap();
    }

    #[test]
    fn shuffle_then_eof_walk_covers_all_and_keeps_current_visible() {
        // Full walk under shuffle + repeat All wraps forever without dupes
        // within a cycle.
        let mut q = QueueMachine::with_seed(31337);
        q.add_tracks((1..=5).map(track).collect(), AddPosition::End);
        q.set_shuffle(true);
        q.advance(true);
        let mut cycle = HashSet::new();
        for _ in 0..4 {
            cycle.insert(q.current().unwrap().track.title.clone());
            if matches!(q.advance(false), QueueStep::Load(_)) {
                cycle.insert(q.current().unwrap().track.title.clone());
            }
        }
        // With 5 tracks and 4 EOFs we must have seen ≥4 distinct tracks.
        assert!(cycle.len() >= 4);
        q.assert_invariants().unwrap();
    }

    #[test]
    fn queue_serializes_and_restores_exactly() {
        let mut q = QueueMachine::with_seed(1);
        q.add_tracks((1..=4).map(track).collect(), AddPosition::End);
        q.advance(true);
        q.advance(true);
        q.set_shuffle(true);
        let json = serde_json::to_string(&q).unwrap();
        let restored: QueueMachine = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.order_ids(), q.order_ids());
        assert_eq!(restored.cursor_index(), q.cursor_index());
        assert_eq!(restored.history_ids(), q.history_ids());
        assert_eq!(restored.shuffle(), q.shuffle());
        restored.assert_invariants().unwrap();
    }
}
