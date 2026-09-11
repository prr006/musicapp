/**
 * Web data provider — search, radio mixes and related metadata, fetched from
 * CORS-enabled Piped API mirrors (open-source YouTube/YouTube Music front-end
 * API). This is the WEB replacement for the desktop Go provider/yt-dlp stack:
 * it supplies METADATA ONLY (track ids, titles, artists, artwork, durations).
 * Audio never flows through here — playback is the YouTube IFrame player
 * (audio/ytPlayer.ts) consuming nothing but the video id.
 *
 * Nothing here extracts, proxies or downloads media; there is no /resolve, no
 * /stream, no getPlayable and no yt-dlp anywhere in the web build.
 */
import type { Album, Artist, SearchResponse, Track } from '../bridge/types'
import { isSongCandidate } from './songCandidateFilter'

/** Mirrors are tried in order; a dead mirror fails over to the next. */
const PIPED_MIRRORS = [
  'https://pipedapi.ducks.party',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.orangenet.cc',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
]

const SEARCH_TIMEOUT_MS = 12_000
const RADIO_TIMEOUT_MS = 12_000

export class ProviderError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** Fetch JSON with timeout + mirror failover. Returns the first good answer. */
export async function pipedFetch<T = unknown>(
  path: string,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS
  let lastError: Error = new ProviderError('No provider mirror is reachable.')
  for (const base of PIPED_MIRRORS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${base}${path}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new ProviderError(`Mirror responded ${res.status}`, res.status)
      const data = (await res.json()) as T
      clearTimeout(timer)
      return data
    } catch (err) {
      clearTimeout(timer)
      lastError = err instanceof Error ? err : new Error(String(err))
      // try the next mirror
    }
  }
  throw lastError
}

/* ---------------- parsing helpers ---------------- */

/**
 * Strips ONLY the most obvious YouTube presentation noise from a title.
 * This is intentionally conservative: we remove phrases that are universally
 * understood as "not part of the song name" and nothing else.
 *
 * Preserved (NOT removed):
 *   - (From "Raaka"), (From "Karuppu") — soundtrack/source references
 *   - feat. Artist, ft. Artist — featured artists
 *   - Part 1, Chapter 1 — subtitles
 *   - Remix, Acoustic, Live — performance variants
 *   - Legitimate hyphens in titles
 *   - Quotes and parentheses in meaningful context
 *
 * Removed (ONLY these exact patterns):
 *   - (Official Music Video), (Official Audio), (Official Video)
 *   - (Lyrics), (Lyric Video)
 *   - (HD), (4K), (1080p)
 *   - (Audio), (Visualizer)
 *   - Trailing " - Topic" channel suffix
 */
export function cleanYouTubeTitle(title: string): string {
  let t = (title || '').replace(/\s+/g, ' ').trim()
  // Remove exact presentation suffixes in parentheses/brackets.
  // Each pattern matches the FULL parenthesized phrase — no partial stripping.
  t = t
    .replace(/\s*[\[\(]\s*Official\s+(Music\s+)?Video\s*[\]\)]\s*/gi, ' ')
    .replace(/\s*[\[\(]\s*Official\s+Audio\s*[\]\)]\s*/gi, ' ')
    .replace(/\s*[\[\(]\s*Official\s*[\]\)]\s*/gi, ' ')
    .replace(/\s*[\[\(]\s*Lyrics?\s*[\]\)]\s*/gi, ' ')
    .replace(/\s*[\[\(]\s*Lyric\s+Video\s*[\]\)]\s*/gi, ' ')
    .replace(/\s*[\[\(]\s*(HD|4K|1080p|720p)\s*[\]\)]\s*/gi, ' ')
    .replace(/\s*[\[\(]\s*Audio\s*[\]\)]\s*/gi, ' ')
    .replace(/\s*[\[\(]\s*Visualizer\s*[\]\)]\s*/gi, ' ')
  // Remove trailing " - Topic" channel suffix (YouTube Music auto-uploads).
  t = t.replace(/\s*-\s*Topic\s*$/i, '')
  // Clean up empty parentheses/brackets left behind after stripping.
  t = t.replace(/\s*[\[\(]\s*[\]\)]\s*/g, ' ')
  return t.replace(/\s+/g, ' ').trim()
}

export interface PipedStreamItem {
  url?: string
  type?: string
  title?: string
  /** Search results under the "channels" filter use `name` for the channel. */
  name?: string
  thumbnail?: string
  uploaderName?: string
  uploaderUrl?: string
  duration?: number
  views?: number
  uploaded?: number
  isShort?: boolean
  id?: string
}

export interface PipedSearchPayload {
  items?: PipedStreamItem[]
  nextpage?: string
  corrected?: boolean
}

export interface PipedPlaylistPayload {
  name?: string
  relatedStreams?: PipedStreamItem[]
  nextpage?: string
}

/**
 * Attempts to split "Artist - Song" from a YouTube title.
 *
 * This is intentionally conservative. A legitimate song title CAN contain "-",
 * so we only split when the separator is clearly an artist/title delimiter:
 *   - surrounded by spaces: "Artist Name - Song Name"
 *   - left side looks like an artist name (not too long, no common song words)
 *   - right side looks like a song title
 *
 * When in doubt, returns the full title as the song with no artist分离.
 * The caller can override the artist using uploaderName (YouTube Music).
 */
function splitTitle(title: string): { artist: string; song: string } {
  const t = (title || '').replace(/\s+/g, ' ').trim()
  // Only match "Artist - Song" where:
  // - The separator is surrounded by spaces (not "word-word")
  // - Left side is 1-60 chars (artist names are usually short)
  // - Right side is 1-150 chars
  // - Left side does NOT contain common song words that indicate it's part of the title
  const m = t.match(/^(.{1,60}?)\s+[-–—]\s+(.{1,150})$/)
  if (m) {
    const artist = m[1].trim()
    const song = m[2].trim()
    // Reject if the "artist" side looks like it's actually part of the song title
    // (e.g. it contains words that commonly appear in song titles)
    const artistLower = artist.toLowerCase()
    const rejectWords = ['from', 'feat', 'ft', 'part', 'chapter', 'remix', 'version', 'live', 'acoustic']
    if (rejectWords.some((w) => artistLower.endsWith(` ${w}`) || artistLower === w)) {
      return { artist: '', song: t }
    }
    if (artist && song && artist.length >= 2) return { artist, song }
  }
  return { artist: '', song: t }
}

function baseId(url: string | undefined): string | null {
  if (!url) return null
  const m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/)
  return m ? m[1] : null
}

/**
 * Broad non-music content filter for search results. Conservative: only
 * rejects titles that are clearly non-song content. Does NOT reject
 * legitimate songs containing words like "live", "remix", "acoustic".
 *
 * The multi-signal isSongCandidate() filter in songCandidateFilter.ts
 * provides additional validation for radio/autoplay candidates.
 */
const NON_MUSIC = /mix\s*[-–\s]|full\s*album|nightcore|slowed\s*\+?\s*reverb|8d\s*audio|sped\s*up|karaoke|instrumental\s*version|backing\s*tracks?|cover\s*by|reaction|tutorial|lesson|album\s*completo|trailer|teaser|behind\s+the\s+scenes?|making\s+of|press\s+(meet|conference)|interview|podcast|vlog|documentary|dialogue\s+promo|scene\s+from|episode\s+promo|serial\s+promo|first\s+look|sneak\s*peek|glimpse|announcement|fan\s+(made|edit|video)|hours?\s+(of|mix)|megamix|nonstop|non-stop|full\s+(album|movie|show|concert)|web\s*series|promo(tional)?/i

/** Music-shaped duration: 0:31 – 15:00. */
function isMusicShaped(duration: number | undefined): boolean {
  if (!duration || duration <= 0) return true // unknown: keep, the player will cope
  return duration >= 31 && duration <= 900
}

function playable(item: PipedStreamItem): boolean {
  return !!baseId(item.url) && !!item.title && item.type === 'stream' && !item.isShort
}

/**
 * Cleans a mirror item into a MELO track. `youtubeMusic` marks rows that came
 * from the music_songs filter (uploader = performing artist, canonical titles).
 *
 * Title cleaning is intentionally CONSERVATIVE: we strip only the most obvious
 * YouTube presentation noise (e.g. "Official Video", "Lyrics", "HD"). We never
 * strip meaningful content such as:
 *   - (From "Raaka"), (From "Karuppu") — soundtrack/source references
 *   - feat. Artist — featured artists
 *   - Part 1, Chapter 1 — subtitles
 *   - Remix, Acoustic, Live — performance variants
 * Legitimate song titles can contain hyphens, parentheses, and quotes.
 */
export function parsePipedItem(item: PipedStreamItem, _youtubeMusic?: boolean): Track | null {
  const sourceId = baseId(item.url)
  if (!sourceId || !item.title) return null
  const cleanedTitle = cleanYouTubeTitle(item.title)
  // Artist: prefer uploaderName (always correct for YouTube Music),
  // then fall back to splitTitle inference for non-music results.
  const { artist: inferredArtist } = splitTitle(item.title)
  const displayArtist = (item.uploaderName || inferredArtist || '').trim()
  // Title is ALWAYS the cleaned full title — never the "song" half of a split.
  return {
    id: `yt:${sourceId}`,
    sourceId,
    source: 'youtube',
    url: `https://www.youtube.com/watch?v=${sourceId}`,
    title: cleanedTitle || item.title,
    artist: displayArtist,
    uploader: item.uploaderName || '',
    album: '',
    artwork: thumbFor(item.thumbnail) || `https://i.ytimg.com/vi/${sourceId}/hqdefault.jpg`,
    duration: item.duration && item.duration > 0 ? item.duration : 0,
    explicit: false,
  }
}

/* ---------------- search ---------------- */

type PipedFilter = 'music_songs' | 'videos' | 'channels' | 'playlists'

const FILTERS: Record<string, PipedFilter> = {
  '': 'music_songs',
  songs: 'music_songs',
  videos: 'videos',
  albums: 'playlists',
  artists: 'channels',
}

export async function pipedSearch(query: string, filter: string): Promise<SearchResponse> {
  const pipedFilter = FILTERS[filter] ?? 'music_songs'
  const encoded = encodeURIComponent(query)
  const payload = await pipedFetch<PipedSearchPayload>(
    `/search?q=${encoded}&filter=${pipedFilter}`,
  )
  const items = (payload.items ?? []).filter(playable)
  const songs: Track[] = []
  for (const item of items) {
    if (NON_MUSIC.test(item.title ?? '')) continue
    if (!isMusicShaped(item.duration)) continue
    const track = parsePipedItem(item, pipedFilter === 'music_songs')
    if (track) songs.push(track)
  }

  if (pipedFilter === 'music_songs') {
    // The primary filter answers with one canonical list; other sections are
    // derived from additional lightweight queries ONLY when the user asked
    // for "All", so typing in the top bar stays one request per keystroke.
    return { query, songs, videos: [], albums: [], artists: [], provider: 'piped' }
  }
  if (pipedFilter === 'videos') {
    return { query, songs: [], videos: songs, albums: [], artists: [], provider: 'piped' }
  }
  if (pipedFilter === 'channels') {
    const artists: Artist[] = (payload.items ?? [])
      .filter((i) => i.type === 'channel' && i.name)
      .slice(0, 12)
      .map((i) => ({
        id: i.id ?? i.uploaderUrl ?? '',
        name: i.name ?? '',
        artwork: thumbFor(i.thumbnail),
        tracks: [],
      }))
      .filter((a) => a.name)
    return { query, songs: [], videos: [], albums: [], artists, provider: 'piped' }
  }
  // playlists (albums)
  const albums: Album[] = (payload.items ?? [])
    .filter((i) => i.type === 'playlist')
    .slice(0, 12)
    .map((i) => {
      const title = (i.name ?? '').replace(/\s*full\s*album\s*playlist\s*/i, '').trim()
      return {
        id: i.id ?? i.url ?? title,
        title,
        artist: i.uploaderName ?? '',
        artwork: thumbFor(i.thumbnail),
        year: '',
        tracks: [],
      }
    })
    .filter((a) => a.title)
  return { query, songs: [], videos: [], albums, artists: [], provider: 'piped' }
}

function thumbFor(url: string | undefined): string {
  return url && url.startsWith('http') ? url : ''
}

/** True pagination for Piped search (their nextpage blob). */
export async function pipedSearchPage(
  query: string,
  nextpage: string,
  filter: string,
): Promise<PipedSearchPayload> {
  const pipedFilter = FILTERS[filter] ?? 'music_songs'
  return pipedFetch<PipedSearchPayload>(
    `/nextpage/search?nextpage=${encodeURIComponent(nextpage)}&q=${encodeURIComponent(query)}&filter=${pipedFilter}`,
  )
}

/* ---------------- radio mixes (the real recommendation source) ---------------- */

/**
 * Fetches the provider's own song-radio mix for a seed video: the same
 * up-next list YouTube Music builds around a song. This is genuine
 * recommendation data — different artists in a coherent style neighborhood —
 * not an artist discography dump and not a title-text search.
 */
export async function pipedRadioMix(sourceId: string): Promise<Track[]> {
  const payload = await pipedFetch<PipedPlaylistPayload>(
    `/playlists/RDAMVM${encodeURIComponent(sourceId)}`,
    { timeoutMs: RADIO_TIMEOUT_MS },
  )
  const streams = payload.relatedStreams ?? []
  const out: Track[] = []
  const seen = new Set<string>()
  for (const item of streams) {
    if (!playable(item)) continue
    const track = parsePipedItem(item, false)
    if (!track) continue
    // Radio rows are "Artist - Song"-shaped; without an artist there is no
    // recommendation identity to rank on — drop rather than guess.
    if (!track.artist) continue
    // Multi-signal non-song filter: reject teasers, trailers, promos, etc.
    if (!isSongCandidate(track)) continue
    if (seen.has(track.sourceId)) continue
    seen.add(track.sourceId)
    out.push(track)
  }
  return out
}

/**
 * Same-artist songs via a targeted music search. Used by the web recommender
 * as a candidate ANCHOR (never as the whole queue): taste-weighted selection
 * happens in lib/profile.ts + lib/radio.ts.
 */
export async function pipedArtistTopSongs(artist: string, limit = 12): Promise<Track[]> {
  const q = artist.trim()
  if (!q) return []
  const payload = await pipedFetch<PipedSearchPayload>(
    `/search?q=${encodeURIComponent(q)}&filter=music_songs`,
  )
  const out: Track[] = []
  for (const item of payload.items ?? []) {
    if (!playable(item) || NON_MUSIC.test(item.title ?? '')) continue
    if (!isMusicShaped(item.duration)) continue
    const track = parsePipedItem(item, true)
    if (!track) continue
    if (!isSongCandidate(track)) continue
    out.push(track)
    if (out.length >= limit) break
  }
  return out
}

/** "Top songs" for a genre/style term — the style-affinity anchor pool. */
export async function pipedGenreTopSongs(genre: string, limit = 12): Promise<Track[]> {
  return pipedArtistTopSongs(genre, limit)
}
