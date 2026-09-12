/**
 * Web lyrics client — LRCLIB (https://lrclib.net), CORS-open, no key.
 *
 * Lyrics are deliberately INDEPENDENT of playback: every failure mode here
 * (network down, no match, malformed timing) resolves to a well-defined
 * result and never touches the player.
 *
 * Recording selection:
 * LRCLIB commonly returns several entries for one song (same title, slightly
 * different durations, different uploaders, or different versions such as
 * live/remix/lyric uploads). The scoring below is "recording-aware": it
 * prefers a hit whose normalized title, primary artist, album and duration
 * best match the *played* recording, and penalizes hits whose version markers
 * disagree with the played version. This prevents picking an unrelated
 * recording (e.g. a remix or a live cut) when the played track is the
 * original, and vice-versa. Synced lyrics still dominate the score.
 *
 * Per-track drift:
 * Some played uploads (e.g. cast-listed music-video edits with a label
 * pre-roll) share the song's title but start their audio a few seconds after
 * the LRCLIB reference recording (the official single). No LRCLIB entry
 * exists for those edits, so no candidate can match them. For those specific
 * tracks we apply an explicit offset via trackDriftOffsets, keyed on the raw
 * played-track identity. This is deliberately per-track, never global.
 */
import type { LyricsQuery, LyricsResult } from '../bridge/types'
import { fetchYtmTimedLyrics } from './ytmusic'

const LRCLIB_BASE = 'https://lrclib.net/api'

/** LRC tags that are not timed lyric lines. */
const META_TAG = /^\[(offset|length|re|ti|ar|al|by|ve|au|tool|note|lang):/i

interface LrcLibHit {
  id: number
  trackName: string
  artistName: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

/**
 * Normalizes a title/artist for comparison: lowercased, punctuation removed,
 * whitespace collapsed. Unicode letters are preserved, so this works for
 * Devanagari / Tamil / Telugu scripts too.
 */
function normalizeTrack(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Version markers that identify a recording edit. When the played track lacks
 * a marker but a candidate has one (or vice-versa) those are different
 * recordings, not just duplicates.
 */
const VERSION_MARKERS = [
  'remix',
  'dj mix',
  'dj remix',
  'live',
  'lofi',
  'lo fi',
  'acoustic',
  'cover',
  'karaoke',
  'instrumental',
  'sped up',
  'spedup',
  'slowed and reverb',
  'slowed and reverbed',
  'slowed + reverb',
  'slowed reverb',
  'super slowed',
  'nightcore',
  'bass boosted',
  'bassboosted',
  'extended',
  'radio edit',
  '8d audio',
  'rewind',
  'lyric video',
  'official lyrics',
  'official video',
  'official hd',
  'lyrics',
  'visualizer',
  'remaster',
  'remastered',
  '4k',
  'edit',
]

/** Casual markers that merely describe the upload, not the recording edit. */
const CASUAL_MARKERS = new Set([
  'lyrics',
  'lyric video',
  'official lyrics',
  'official video',
  'visualizer',
  'official hd',
  'video',
  'audio',
  'hd',
  '4k',
  'remaster',
  'remastered',
])

function versionOf(title: string): string {
  const t = normalizeTrack(title)
  for (const marker of VERSION_MARKERS) {
    if (t.includes(marker)) return marker
  }
  return ''
}

function cleanTitle(title: string): string {
  return (title || '')
    .replace(/\s*[\(\[](official|lyric[s]?|audio|video|visualizer|hd|4k|remaster(ed)?( [0-9]{4})?|.*(version|edit|mix)).*[\)\]]/gi, '')
    .replace(/\s*[-–—|].*$/, '') // "Artist - Song" tails from uploads
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanArtist(artist: string): string {
  return (artist || '').split(/,| & | feat\.? | ft\.? /i)[0]?.trim() ?? ''
}

/** Parses an LRC payload; drops malformed timing rather than trusting it. */
export function parseLrc(lrc: string): { time: number; text: string }[] {
  let offsetMs = 0
  const lines: { time: number; text: string }[] = []
  for (const raw of lrc.split('\n')) {
    const tag = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i)
    if (tag) {
      offsetMs = Number(tag[1])
      continue
    }
    const m = raw.match(/^\s*\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)$/)
    if (!m || META_TAG.test(raw)) continue
    const minutes = Number(m[1])
    const seconds = Number(m[2])
    const fraction = m[3] ? Number(`0.${m[3]}`) : 0
    const time = minutes * 60 + seconds + fraction + offsetMs / 1000
    if (!Number.isFinite(time) || time < 0) continue
    lines.push({ time, text: m[4].trim() })
  }
  lines.sort((a, b) => a.time - b.time)
  return lines
}

async function lrcFetch(path: string, timeoutMs = 10_000): Promise<LrcLibHit[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${LRCLIB_BASE}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const data = (await res.json()) as LrcLibHit[] | LrcLibHit
    clearTimeout(timer)
    return Array.isArray(data) ? data : [data]
  } catch {
    clearTimeout(timer)
    return null
  }
}

export interface HitContext {
  title: string
  rawTitle?: string
  artist: string
  album: string
  duration: number
}

function scoreHit(hit: LrcLibHit, ctx: HitContext): number {
  let score = 0
  if (hit.syncedLyrics) score += 4
  else if (hit.plainLyrics) score += 1

  const hTitle = normalizeTrack(hit.trackName)
  const hArtist = normalizeTrack(hit.artistName)
  const qTitle = normalizeTrack(ctx.title)
  const qRawTitle = normalizeTrack(ctx.rawTitle || ctx.title)

  // Prefer a recording whose length matches the played upload.
  if (ctx.duration > 0 && hit.duration && hit.duration > 0) {
    const d = Math.abs(hit.duration - ctx.duration)
    // Hard rejection: >30s mismatch is almost certainly a different song.
    if (d > 30) return -100
    if (d <= 2) score += 4
    else if (d <= 5) score += 2
    else if (d < 8) score += 1
  } else if (ctx.duration > 0 && (!hit.duration || hit.duration <= 0)) {
    score -= 1
  }

  // Title closeness (against both the cleaned and the raw played title).
  if (hTitle === qTitle || hTitle === qRawTitle) score += 2
  else if (
    hTitle.includes(qTitle) ||
    qTitle.includes(hTitle) ||
    hTitle.includes(qRawTitle) ||
    qRawTitle.includes(hTitle)
  ) {
    score += 1
  }

  // Version markers: a hit claiming a different edit than the played track is
  // almost certainly the wrong recording.
  const qVers = versionOf(qRawTitle)
  const hVers = versionOf(hTitle)
  if (qVers) {
    if (hVers === qVers) score += 1
    else if (hVers && !CASUAL_MARKERS.has(qVers)) score -= 6
  } else if (hVers && !CASUAL_MARKERS.has(hVers)) {
    score -= 6
  }

  // Primary artist containment (played upload's artist vs the recording's).
  const qArtist = normalizeTrack(ctx.artist)
  if (qArtist && qArtist.length > 1) {
    if (hArtist.includes(qArtist) || qArtist.includes(hArtist)) score += 3
  }

  // Album agreement is weak evidence but helps de-duplicate same-title hits.
  // When both sides have an album name that doesn't agree, penalize.
  const qAlbum = normalizeTrack(ctx.album)
  const hAlbum = normalizeTrack(hit.albumName ?? '')
  if (qAlbum && hAlbum) {
    if (hAlbum.includes(qAlbum) || qAlbum.includes(hAlbum)) score += 1
    else score -= 2
  }

  if (hit.instrumental) score -= 4

  return score
}

/**
 * Minimum score for a synced candidate to be accepted. Below this, we return
 * no synced lyrics rather than risk showing lyrics from the wrong song.
 * A wrong lyric match is worse than no synced lyrics.
 */
const MIN_SYNCED_CONFIDENCE = 4

/**
 * Selects the candidate recording closest to the played track. Synced lyrics
 * win outright; among synced candidates the recording's title, artist, album
 * and duration decide, with version-marker mismatches treated as the decisive
 * negative signal they are.
 */
function bestMatch(hits: LrcLibHit[], ctx: HitContext): LrcLibHit | null {
  if (hits.length === 0) return null
  const scored = hits.map((hit) => ({ hit, score: scoreHit(hit, ctx) }))
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  // Reject hard-rejected candidates (score <= -100 from duration mismatch).
  if (best.score <= -100) return null
  // For synced candidates, enforce a confidence floor. A wrong synced lyric
  // is worse than no synced lyrics.
  if (best.hit.syncedLyrics && best.score < MIN_SYNCED_CONFIDENCE) return null
  return best.hit
}
export { bestMatch }

export interface TrackDriftOverride {
  /** Normaliized played-title; exact match when set. */
  normTitle?: string
  /** Every token must appear in the normalized played-title. */
  requiredTokens?: string[]
  /** Normalized played artist; empty means any. */
  normArtist: string
  /** Seconds to add to playback position for this track (negative = later). */
  offset: number
  minDur?: number
  maxDur?: number
}

/**
 * Per-track timing corrections for uploads whose audio edit differs from any
 * LRCLIB reference recording (e.g. cast-listed music videos with a label
 * pre-roll). Keyed on the played-track identity (title tokens, artist,
 * duration band) so the correction can never leak onto other songs.
 *
 * Entries must be verified against the actual audio of that specific upload;
 * a wrong value here is worse than none, so only add one when the offset has
 * been confirmed.
 */
export const trackDriftOffsets: TrackDriftOverride[] = [
  {
    // Cast-listed uploads of the "Yeshanagula" film song (titles that include
    // the film's stars, e.g. "Yeshanagula | The Paradise | Nani | Keerthy
    // Suresh | Anirudh Ravichander", with or without a director suffix) open
    // with a label pre-roll ~3s before the music. The LRCLIB reference (the
    // official single, 188s) starts at 0, so all of its lines fire ~3s early
    // on these uploads. Shift them later. The fanmade/DJ mirrors (no star
    // names in the title) are excluded on purpose.
    requiredTokens: ['yeshanagula', 'nani', 'keerthy suresh', 'anirudh ravichander'],
    normArtist: '',
    offset: -3,
    minDur: 185,
    maxDur: 196,
  },
]

/** Looks up a per-track drift correction for the played track; 0 if none. */
export function resolveTrackDrift(query: LyricsQuery): number {
  const qTitle = normalizeTrack(query.title)
  const qArtist = normalizeTrack(query.artist)
  for (const o of trackDriftOffsets) {
    if (o.normTitle && qTitle !== o.normTitle) continue
    if (o.requiredTokens && !o.requiredTokens.every((t) => qTitle.includes(t))) continue
    if (o.normArtist && qArtist !== o.normArtist && !qArtist.includes(o.normArtist)) continue
    if (o.minDur != null && query.duration < o.minDur) continue
    if (o.maxDur != null && query.duration > o.maxDur) continue
    return o.offset
  }
  return 0
}

export class LyricsNotFoundError extends Error {
  constructor() {
    super('No lyrics found.')
    this.name = 'LyricsNotFoundError'
  }
}

/** Fetches lyrics for a track; throws LyricsNotFoundError when none exist. */
export async function fetchWebLyrics(query: LyricsQuery): Promise<LyricsResult> {
  const title = cleanTitle(query.title)
  const artist = cleanArtist(query.artist)
  if (!title) throw new LyricsNotFoundError()

  const ctx: HitContext = {
    title,
    rawTitle: query.title,
    artist,
    album: query.album,
    duration: query.duration,
  }

  // 1) precise query (title + artist) — best metadata match
  let hits = await lrcFetch(
    `/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`,
  )
  let hit = bestMatch(hits ?? [], ctx)

  // 2) relaxed query: title only
  if (!hit) {
    hits = await lrcFetch(`/search?track_name=${encodeURIComponent(title)}`)
    hit = bestMatch(hits ?? [], ctx)
  }

  // 3) free-text query with everything we know
  if (!hit) {
    hits = await lrcFetch(`/search?q=${encodeURIComponent(`${title} ${artist}`.trim())}`)
    hit = bestMatch(hits ?? [], ctx)
  }

  if (!hit) throw new LyricsNotFoundError()

  const synced = hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : []
  if (!hit.plainLyrics && synced.length === 0) throw new LyricsNotFoundError()

  // 4) YTM fallback: when LRCLIB has no synced lyrics, or the synced lyrics
  //    are structurally suspect (large duration mismatch), try YouTube Music.
  const hasGoodSynced = synced.length >= 2
  const isStructurallySuspect =
    hasGoodSynced &&
    query.duration > 0 &&
    hit.duration != null &&
    hit.duration > 0 &&
    Math.abs(hit.duration - query.duration) > 5

  if (!hasGoodSynced || isStructurallySuspect) {
    try {
      const ytm = await fetchYtmTimedLyrics(title, artist, query.duration)
      if (ytm && ytm.synced.length >= 2) {
        return {
          trackId: query.trackId,
          source: 'ytmusic',
          synced: true,
          lines: ytm.synced,
          plain: ytm.plain,
          instrumental: false,
          offset: 0,
          matchedTitle: hit.trackName,
          matchedArtist: hit.artistName,
        }
      }
    } catch {
      // YTM fallback failed — fall through to LRCLIB result
    }
  }

  return {
    trackId: query.trackId,
    source: 'lrclib',
    synced: synced.length >= 2,
    lines: synced,
    plain: hit.plainLyrics ?? synced.map((l) => l.text).join('\n'),
    instrumental: !!hit.instrumental,
    offset: resolveTrackDrift(query),
    matchedTitle: hit.trackName,
    matchedArtist: hit.artistName,
  }
}