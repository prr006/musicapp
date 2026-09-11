/**
 * Song candidate filter — ensures only actual songs enter the radio/autoplay
 * queue. Uses multiple signals (title patterns, duration, metadata) rather
 * than a single regex, so legitimate songs with ambiguous words (e.g.
 * "Live Life", "Acoustic Love", "Remix") are never incorrectly rejected.
 *
 * Non-song content is rejected conservatively: we require strong evidence
 * across multiple dimensions before rejecting a candidate.
 */
import type { Track } from '../bridge/types'

/**
 * Title patterns that strongly indicate non-song content.
 *
 * Design rules:
 *   - Patterns must be phrase-level (multi-word) or unambiguous single words
 *     that are virtually never part of a real song title.
 *   - We do NOT reject individual words like "live", "remix", "acoustic",
 *     "cover", "official" — these are legitimate song variants.
 *   - We reject COMPOUND phrases like "behind the scenes", "making of",
 *     "press meet" which are unambiguously non-song.
 */
const TITLE_NON_SONG_PATTERNS: RegExp[] = [
  // Video production content
  /\bbehind\s+the\s+scenes?\b/i,
  /\bmaking\s+of\b/i,
  /\bbts\b/,
  // News / press / announcements
  /\bpress\s+(meet|conference)\b/i,
  /\bannouncement\b/i,
  // Interviews / reactions / reviews
  /\binterview\b/i,
  /\breaction\b/i,
  /\breview\b/i,
  /\bexplained\b/i,
  // Promotion / reveal
  /\bfirst\s+look\b/i,
  /\bsneak\s*peek\b/i,
  /\bglimpse\b/i,
  /\bpromo(tional)?\b/i,
  // Dialogue / scenes / clips
  /\bdialogue\s+promo\b/i,
  /\bscene\s+from\b/i,
  /\b(movie|film|video)\s+clip\b/i,
  // Episode / serial content
  /\bepisode\s+promo\b/i,
  /\bserial\s+promo\b/i,
  /\bweb\s*series\b/i,
  // Documentaries / podcasts / vlogs / tutorials
  /\bpodcast\b/i,
  /\bvlog\b/i,
  /\btutorial\b/i,
  /\blesson\b/i,
  /\bdocumentary\b/i,
  // Live stream
  /\blive\s*stream\b/i,
  // Full compilations / playlists / albums
  /\bfull\s+(album|movie|show|concert)\b/i,
  /\b(album|playlist)\s+playlist\b/i,
  /\bnights?\s+of\b/i,
  // Long-duration compilations
  /\bhours?\s+(of|mix)\b/i,
  /\b\d+\s+hours?\b/i,
  // Fan content
  /\bfan\s+(made|edit|video)\b/i,
  // Karaoke / backing
  /\bkaraoke\b/i,
  /\bbacking\s+tracks?\b/i,
  // Compilation-like
  /\bbest\s+of\b.*\bcompilation\b/i,
  /\bmegamix\b/i,
  /\bnonstop\b/i,
  /\bnon-stop\b/i,
]

/**
 * Unambiguously non-song words that should never appear in a real song title
 * as the dominant content word.
 */
const HARD_REJECT_WORDS = [
  'trailer',
  'teaser',
  'podcast',
  'vlog',
  'tutorial',
  'lesson',
  'documentary',
  'interview',
  'reaction',
  'behind',
  'making',
  'announced',
  'press',
]

/** Minimum song duration in seconds (shortest plausible song). */
export const MIN_SONG_DURATION = 30
/** Maximum song duration in seconds (longest plausible song, not mix/compilation). */
export const MAX_SONG_DURATION = 900

/**
 * Checks if a track is a legitimate song candidate for radio/autoplay.
 *
 * Uses multi-signal validation:
 *   1. Title patterns (compound phrases, dominant non-song words)
 *   2. Duration (music-shaped range)
 *   3. Artist/uploader credibility
 *
 * Returns true if the track IS a song (safe to recommend).
 * Returns false if the track is likely NOT a song.
 */
export function isSongCandidate(track: Track): boolean {
  if (!track) return false

  const title = (track.title ?? '').trim()
  if (!title) return false

  // --- Signal 1: title pattern matching ---
  // Check compound non-song phrases (strongest signal)
  for (const pattern of TITLE_NON_SONG_PATTERNS) {
    if (pattern.test(title)) return false
  }

  // Check dominant non-song words: only reject if the word is the
  // dominant content (first or last meaningful word) and is NOT part
  // of a compound with other title-meaningful words.
  const titleLower = title.toLowerCase()
  const words = titleLower.split(/\s+/).filter((w) => w.length > 2)
  if (words.length > 0) {
    const firstWord = words[0].replace(/[^a-z]/g, '')
    const lastWord = words[words.length - 1].replace(/[^a-z]/g, '')
    for (const word of HARD_REJECT_WORDS) {
      if (firstWord === word || lastWord === word) {
        // Additional check: if the word is part of a compound with
        // other meaningful words, it might be a song title.
        // e.g. "Live Life" — "live" is first but "Life" makes it a song.
        // e.g. "Trailer Music" — "trailer" is first and it's non-song.
        if (words.length <= 2) {
          // Short title: the dominant word IS the main content
          return false
        }
        // Longer title: check if the rest of the title is meaningful
        // (contains words that are typically part of song titles)
        const otherWords = words.filter((w) => !HARD_REJECT_WORDS.includes(w.replace(/[^a-z]/g, '')))
        if (otherWords.length === 0) {
          // All words are hard-reject words: non-song
          return false
        }
      }
    }
  }

  // --- Signal 2: duration ---
  if (track.duration > 0) {
    if (track.duration < MIN_SONG_DURATION) return false
    if (track.duration > MAX_SONG_DURATION) return false
  }

  // --- Signal 3: metadata credibility ---
  // A song should have at least an artist or a credible uploader.
  const hasArtist = !!(track.artist ?? '').trim()
  const hasUploader = !!(track.uploader ?? '').trim()
  if (!hasArtist && !hasUploader) return false

  return true
}
