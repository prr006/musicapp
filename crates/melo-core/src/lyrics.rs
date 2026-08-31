//! Lyrics: parsing + the synchronization model.
//!
//! The critical rule (spec §11): lyrics have **no independent clock**. The
//! only input to "which line is current" is the authoritative playback
//! position published by the playback state machine (which itself mirrors the
//! engine). Looking up the active line is a pure function:
//!
//! ```text
//!   active_index(position_secs) = last line with time_ms <= position_secs*1000
//! ```
//!
//! Because it is position-derived, it is automatically correct after seeks,
//! pauses, buffering, track changes, EOF auto-next, restarts, and playback
//! speed changes (position already accounts for speed). Binary search keeps
//! it O(log n) at 4–5 Hz updates.
//!
//! The data model reserves `translation` and `pronunciation` fields now so
//! Apple-Music-style extras (spec §11 "future enhancement") need no migration.

use serde::{Deserialize, Serialize};

/// One line of lyrics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    /// Milliseconds into the track; `None` for unsynced lyrics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_ms: Option<u64>,
    pub text: String,
    /// Translated text (future: LRCLIB returns `translatedLyrics`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    /// Romanized/pronunciation line (future).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pronunciation: Option<String>,
}

/// A lyrics document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    pub synced: bool,
    /// e.g. `"lrclib"`, `"local"`.
    pub provider: String,
    pub lines: Vec<LyricLine>,
    /// Track duration in ms as reported by LRCLIB (used to sanity-check sync).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Provider marked the track as instrumental (no vocal lyrics exist).
    #[serde(default)]
    pub instrumental: bool,
}

impl Lyrics {
    pub fn unavailable() -> Self {
        Self {
            synced: false,
            provider: String::new(),
            lines: Vec::new(),
            duration_ms: None,
            instrumental: false,
        }
    }

    pub fn instrumental() -> Self {
        Self {
            synced: false,
            provider: String::new(),
            lines: Vec::new(),
            duration_ms: None,
            instrumental: true,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.lines.iter().all(|l| l.text.trim().is_empty())
    }

    /// Index of the line that should be highlighted at `position_secs`.
    /// `None` before the first timestamp or when unsynced.
    pub fn active_index(&self, position_secs: f64) -> Option<usize> {
        if !self.synced || self.lines.is_empty() {
            return None;
        }
        let pos_ms = if position_secs.is_finite() && position_secs > 0.0 {
            // round(), not truncate: 83.42 * 1000.0 is 83419.999… in f64 and
            // the spec's canonical example (position 83.42 → 1:23.42 line)
            // must highlight that exact line.
            (position_secs * 1000.0).round() as u64
        } else {
            0
        };
        let mut lo = 0usize;
        let mut hi = self.lines.len();
        while lo < hi {
            let mid = (lo + hi) / 2;
            match self.lines[mid].time_ms {
                Some(t) if t <= pos_ms => lo = mid + 1,
                _ => hi = mid,
            }
        }
        if lo == 0 {
            None // before the first line
        } else {
            Some(lo - 1)
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum LyricsParseError {
    /// LRC text present but contained no timestamps at all.
    NoTimestamps,
}

/// Parse an LRC document (synced). Supports:
/// * `[mm:ss]`, `[mm:ss.cc]`, `[mm:ss.xxx]` (2–3 fraction digits)
/// * multiple timestamps per line (`[00:12.00][01:45.10]text`)
/// * metadata tags (`[ti:]`, `[ar:]`, `[al:]`, `[by:]`, `[length:]`)
/// * `[offset:+/-ms]` global offset
/// * word-level enhanced-LRC timestamps (`<00:12.500>`), which are stripped
pub fn parse_lrc(input: &str) -> Result<Lyrics, LyricsParseError> {
    let mut lines: Vec<LyricLine> = Vec::new();
    let mut offset_ms: i64 = 0;

    for raw in input.lines() {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Consume all leading [..] tags.
        let mut rest = line;
        let mut timestamps: Vec<u64> = Vec::new();
        loop {
            let Some(close) = rest.find(']') else { break };
            let tag = &rest[rest.find('[').map(|i| i + 1).unwrap_or(0)..close];
            if rest.find('[') != Some(0) {
                break; // not a leading tag
            }
            if let Some(t) = parse_lrc_timestamp(tag) {
                timestamps.push(t);
            } else if let Some(value) = tag.strip_prefix("offset:") {
                let v: i64 = value.trim().parse().unwrap_or(0);
                offset_ms = v;
            }
            // Other metadata tags (ti:, ar:, al:, ...) are ignored.
            rest = &rest[close + 1..];
        }
        let text = strip_word_timestamps(rest.trim()).to_string();
        if timestamps.is_empty() {
            if !text.is_empty() && text != line.trim() {
                // A line with no timestamp and no tags: treat as unsynced
                // fragment — only valid if we're already unsynced.
                continue;
            }
            continue;
        }
        for t in timestamps {
            lines.push(LyricLine {
                time_ms: Some(apply_offset(t, offset_ms)),
                text: text.clone(),
                translation: None,
                pronunciation: None,
            });
        }
    }

    if lines.is_empty() {
        return Err(LyricsParseError::NoTimestamps);
    }
    lines.sort_by_key(|l| l.time_ms.unwrap_or(0));
    Ok(Lyrics {
        synced: true,
        provider: "lrc".into(),
        lines,
        duration_ms: None,
        instrumental: false,
    })
}

/// Parse plain (unsynced) lyrics.
pub fn parse_plain(input: &str, provider: &str) -> Lyrics {
    let lines: Vec<LyricLine> = input
        .lines()
        .map(|l| l.trim_end_matches('\r'))
        .map(|l| LyricLine {
            time_ms: None,
            text: l.to_string(),
            translation: None,
            pronunciation: None,
        })
        .collect();
    Lyrics {
        synced: false,
        provider: provider.to_string(),
        lines,
        duration_ms: None,
        instrumental: false,
    }
}

fn apply_offset(t: u64, offset_ms: i64) -> u64 {
    if offset_ms >= 0 {
        t.saturating_add(offset_ms as u64)
    } else {
        t.saturating_sub(offset_ms.unsigned_abs())
    }
}

/// `[..]` tag contents → ms. Accepts `mm:ss`, `mm:ss.cc`, `mm:ss.xxx`.
fn parse_lrc_timestamp(tag: &str) -> Option<u64> {
    let (mins, rest) = tag.split_once(':')?;
    let mins: u64 = mins.parse().ok()?;
    let (secs, frac) = match rest.split_once('.') {
        Some((s, f)) => (s, Some(f)),
        None => (rest, None),
    };
    if secs.is_empty() || secs.len() > 2 {
        return None;
    }
    let secs: u64 = secs.parse().ok()?;
    let frac_ms = match frac {
        None => 0,
        Some(f) => {
            // 1 digit = 100ms units, 2 = 10ms, 3 = ms, more = truncate.
            let f = &f[..f.len().min(3)];
            if f.is_empty() {
                0
            } else {
                let v: u64 = f.parse().ok()?;
                match f.len() {
                    1 => v * 100,
                    2 => v * 10,
                    _ => v,
                }
            }
        }
    };
    if secs > 59 {
        return None;
    }
    Some(mins * 60_000 + secs * 1_000 + frac_ms)
}

/// Strip enhanced-LRC word timestamps: `word<00:12.50>word`.
fn strip_word_timestamps(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '<' {
            let mut depth_content = String::new();
            let mut valid = true;
            for inner in chars.by_ref() {
                if inner == '>' {
                    break;
                }
                depth_content.push(inner);
                if inner == '<' || depth_content.len() > 12 {
                    valid = false;
                    break;
                }
            }
            let is_ts = parse_lrc_timestamp(depth_content.trim()).is_some();
            if !is_ts || !valid {
                out.push('<');
                out.push_str(&depth_content);
                out.push('>');
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Parsed LRCLIB `/api/get` / `/api/search` entry (JSON → `Lyrics`).
///
/// <https://lrclib.net/docs> — fields: `syncedLyrics`, `plainLyrics`,
/// `trackName`, `artistName`, `duration`, `id`.
#[derive(Debug, Clone, Deserialize)]
pub struct LrclibEntry {
    #[serde(default)]
    pub id: Option<u64>,
    #[serde(default)]
    pub track_name: Option<String>,
    #[serde(default)]
    pub artist_name: Option<String>,
    #[serde(default)]
    pub album_name: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub instrumental: bool,
    #[serde(default)]
    pub synced_lyrics: Option<String>,
    #[serde(default)]
    pub plain_lyrics: Option<String>,
}

impl LrclibEntry {
    /// Convert to our model: synced > plain > instrumental > unavailable.
    pub fn into_lyrics(self) -> Lyrics {
        let duration_ms = self.duration.map(|d| (d * 1000.0).round() as u64);
        if self.instrumental {
            return Lyrics::instrumental();
        }
        if let Some(synced) = self.synced_lyrics.as_deref().and_then(parse_lrc_ok) {
            let mut lyrics = synced;
            lyrics.provider = "lrclib".into();
            lyrics.duration_ms = duration_ms;
            return lyrics;
        }
        if let Some(plain) = &self.plain_lyrics {
            let mut lyrics = parse_plain(plain, "lrclib");
            lyrics.duration_ms = duration_ms;
            return lyrics;
        }
        Lyrics::unavailable()
    }
}

fn parse_lrc_ok(input: &str) -> Option<Lyrics> {
    parse_lrc(input).ok()
}

/// Pick the best LRCLIB search hit for a track. Scoring (higher wins):
/// * exact-ish title match (+40), contains (+15)
/// * exact artist match (+30), contains (+10)
/// * duration within ±3 s (+25) or ±10 s (+10)
/// * has synced lyrics (+8), not instrumental (+4)
///
/// Returns `None` when no entry is even a weak match (avoid showing lyrics
/// for a completely different song).
pub fn best_match<'a>(
    entries: &'a [LrclibEntry],
    title: &str,
    artist: &str,
    duration_secs: Option<f64>,
) -> Option<&'a LrclibEntry> {
    fn norm(s: &str) -> String {
        s.to_lowercase().chars().filter(|c| c.is_alphanumeric() || *c == ' ').collect::<String>()
    }
    let title_n = norm(title);
    let artist_n = norm(artist);
    let mut best: Option<(i32, &LrclibEntry)> = None;
    for entry in entries {
        let etitle = entry.track_name.as_deref().unwrap_or("");
        let eartist = entry.artist_name.as_deref().unwrap_or("");
        let mut score = 0;
        if norm(etitle) == title_n && !title_n.is_empty() {
            score += 40;
        } else if norm(etitle).contains(&title_n) && !title_n.is_empty() {
            score += 15;
        }
        if !artist_n.is_empty() {
            if norm(eartist) == artist_n {
                score += 30;
            } else if norm(eartist).contains(&artist_n) || artist_n.contains(&norm(eartist)) {
                score += 10;
            }
        }
        if let (Some(want), Some(got)) = (duration_secs, entry.duration) {
            let delta = (want - got).abs();
            if delta <= 3.0 {
                score += 25;
            } else if delta <= 10.0 {
                score += 10;
            }
        }
        if entry.synced_lyrics.is_some() {
            score += 8;
        }
        if !entry.instrumental {
            score += 4;
        }
        if score >= 25 || (score >= 15 && entry.instrumental) {
            if best.map(|(s, _)| score > s).unwrap_or(true) {
                best = Some((score, entry));
            }
        }
    }
    best.map(|(_, e)| e)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LRC: &str = "\
[ti:Neon River]
[ar:Aster Vale]
[00:00.00]Intro line
[00:12.50]First verse
[01:23.42]Chorus
[00:45.10][02:10.00]Repeated hook
[03:00]Outro
";

    fn parsed() -> Lyrics {
        parse_lrc(LRC).expect("parse")
    }

    #[test]
    fn parses_timestamps_in_various_formats() {
        let lyrics = parsed();
        let times: Vec<u64> = lyrics.lines.iter().map(|l| l.time_ms.unwrap()).collect();
        assert_eq!(
            times,
            vec![0, 12_500, 45_100, 60_000 + 23_420, 120_000 + 10_000, 180_000]
        );
    }

    #[test]
    fn multi_timestamp_lines_are_split_and_sorted() {
        let lyrics = parsed();
        // "Repeated hook" appears at 45.10s and 2:10.
        let hook_idx: Vec<usize> = lyrics
            .lines
            .iter()
            .enumerate()
            .filter(|(_, l)| l.text == "Repeated hook")
            .map(|(i, _)| i)
            .collect();
        assert_eq!(hook_idx.len(), 2);
        assert!(hook_idx[0] < hook_idx[1]);
        // Sorted overall.
        let mut times: Vec<u64> = lyrics.lines.iter().map(|l| l.time_ms.unwrap()).collect();
        let mut sorted = times.clone();
        sorted.sort();
        times.sort();
        assert_eq!(times, sorted);
    }

    #[test]
    fn metadata_tags_are_not_lyric_lines() {
        let lyrics = parsed();
        assert!(!lyrics.lines.iter().any(|l| l.text.contains("Aster Vale")));
        assert!(!lyrics.lines.iter().any(|l| l.text.contains("ti:")));
    }

    #[test]
    fn active_line_follows_position_exactly() {
        let lyrics = parsed();
        // The spec's example: position = 83.42s → 1:23.42 chorus.
        let idx = lyrics.active_index(83.42).unwrap();
        assert_eq!(lyrics.lines[idx].text, "Chorus");
        // Just before the chorus line.
        let idx = lyrics.active_index(83.41).unwrap();
        assert_eq!(lyrics.lines[idx].text, "First verse");
    }

    #[test]
    fn active_line_before_first_is_none() {
        let lrc = "[00:10.00]First\n[00:20.00]Second\n";
        let lyrics = parse_lrc(lrc).unwrap();
        assert_eq!(lyrics.active_index(5.0), None);
        assert_eq!(lyrics.active_index(10.0), Some(0));
        assert_eq!(lyrics.active_index(15.0), Some(0));
        assert_eq!(lyrics.active_index(25.0), Some(1));
    }

    #[test]
    fn active_at_zero_with_zero_timestamp_is_first_line() {
        let idx = parsed().active_index(0.0).unwrap();
        assert_eq!(lyrics_line(&parsed(), idx), "Intro line");
    }

    fn lyrics_line(l: &Lyrics, idx: usize) -> &str {
        l.lines[idx].text.as_str()
    }

    #[test]
    fn seeking_back_and_forth_is_consistent() {
        let lyrics = parsed();
        assert_eq!(lyrics.active_index(200.0), Some(5)); // outro
        assert_eq!(lyrics.active_index(50.0), Some(2)); // repeated hook
        assert_eq!(lyrics.active_index(130.5), Some(4)); // repeated hook (2nd)
        assert_eq!(lyrics.active_index(12.5), Some(1));
    }

    #[test]
    fn pause_and_speed_are_position_derived_so_stay_in_sync() {
        // Paused at 83.42 for a long time: still the chorus (no drift,
        // because there is no independent clock).
        let lyrics = parsed();
        assert_eq!(lyrics.active_index(83.42), lyrics.active_index(83.42));
        // At 2x speed the engine still reports real media time.
        assert_eq!(lyrics.lines[lyrics.active_index(90.0).unwrap()].text, "Chorus");
    }

    #[test]
    fn offset_tag_shifts_all_lines() {
        let lrc = "[offset:+500]\n[00:10.00]Line\n";
        let lyrics = parse_lrc(lrc).unwrap();
        assert_eq!(lyrics.lines[0].time_ms, Some(10_500));
        let neg = "[offset:-1000]\n[00:10.00]Line\n";
        assert_eq!(parse_lrc(neg).unwrap().lines[0].time_ms, Some(9_000));
    }

    #[test]
    fn enhanced_lrc_word_timestamps_are_stripped() {
        let lrc = "[00:05.00]Hello <00:05.10>wor<00:05.40>ld\n";
        let lyrics = parse_lrc(lrc).unwrap();
        assert_eq!(lyrics.lines[0].text, "Hello world");
    }

    #[test]
    fn no_timestamps_is_an_error_for_synced_parse() {
        assert_eq!(parse_lrc("just text\nmore text\n"), Err(LyricsParseError::NoTimestamps));
    }

    #[test]
    fn plain_lyrics_are_unsynced_and_never_highlight() {
        let lyrics = parse_plain("line one\nline two", "test");
        assert!(!lyrics.synced);
        assert_eq!(lyrics.lines.len(), 2);
        assert_eq!(lyrics.active_index(10.0), None);
    }

    #[test]
    fn lrclib_entry_prefers_synced_then_plain() {
        let synced = LrclibEntry {
            id: Some(1),
            track_name: Some("T".into()),
            artist_name: Some("A".into()),
            album_name: None,
            duration: Some(180.0),
            instrumental: false,
            synced_lyrics: Some("[00:01.00]one\n".into()),
            plain_lyrics: Some("one".into()),
        };
        let l = synced.into_lyrics();
        assert!(l.synced);
        assert_eq!(l.provider, "lrclib");
        assert_eq!(l.duration_ms, Some(180_000));

        let plain = LrclibEntry {
            id: Some(2),
            track_name: None,
            artist_name: None,
            album_name: None,
            duration: None,
            instrumental: false,
            synced_lyrics: None,
            plain_lyrics: Some("only plain".into()),
        };
        let l = plain.into_lyrics();
        assert!(!l.synced);
        assert_eq!(l.lines[0].text, "only plain");
    }

    #[test]
    fn lrclib_instrumental_flag_short_circuits() {
        let entry = LrclibEntry {
            id: Some(3),
            track_name: Some("T".into()),
            artist_name: None,
            album_name: None,
            duration: None,
            instrumental: true,
            synced_lyrics: None,
            plain_lyrics: None,
        };
        let l = entry.into_lyrics();
        assert!(l.instrumental);
        assert!(l.lines.is_empty());
        assert!(!l.synced);
    }

    #[test]
    fn lrclib_best_match_scores_correctly() {
        let mk = |title: &str, artist: &str, dur: Option<f64>, synced: bool| LrclibEntry {
            id: None,
            track_name: Some(title.into()),
            artist_name: Some(artist.into()),
            album_name: None,
            duration: dur,
            instrumental: false,
            synced_lyrics: synced.then(|| "[00:01.00]x".to_string()),
            plain_lyrics: None,
        };
        let entries = vec![
            mk("Neon River (Remix)", "Someone Else", Some(222.0), false),
            mk("Neon River", "Aster Vale", Some(222.5), true),
            mk("Completely Different", "Other Artist", Some(100.0), false),
        ];
        let best = best_match(&entries, "Neon River", "Aster Vale", Some(222.4)).unwrap();
        assert_eq!(best.track_name.as_deref(), Some("Neon River"));

        // No title/artist/duration overlap at all → no match rather than a
        // wrong song's lyrics.
        let none = vec![mk("Different Song", "Other", Some(999.0), false)];
        assert!(best_match(&none, "Neon River", "Aster Vale", Some(222.0)).is_none());

        // Duration tolerance: 2 s off still wins.
        let close = vec![mk("Neon River", "Aster Vale", Some(220.0), false)];
        assert!(best_match(&close, "Neon River", "Aster Vale", Some(222.0)).is_some());

        // 60 s off with matching names still matches (names dominate).
        let far = vec![mk("Neon River", "Aster Vale", Some(160.0), false)];
        assert!(best_match(&far, "Neon River", "Aster Vale", Some(222.0)).is_some());
    }

    #[test]
    fn lyrics_roundtrip_through_json() {
        let lyrics = parsed();
        let json = serde_json::to_string(&lyrics).unwrap();
        let back: Lyrics = serde_json::from_str(&json).unwrap();
        assert_eq!(back, lyrics);
        // Old serialized lyrics (no instrumental field) still load.
        let legacy = serde_json::json!({"synced": true, "provider": "lrc", "lines": []});
        let l: Lyrics = serde_json::from_value(legacy).unwrap();
        assert!(!l.instrumental);
    }
}
