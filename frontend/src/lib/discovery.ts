import type { Track } from '../bridge/types'
import { dedupeTracks } from './queue'

export const DISCOVERY_ARTIST_LIMIT = 2

/**
 * Normalizes a title so that different uploads of the same song compare equal
 * ("Believer", "Believer (Official Video)", "Believer - Lyrics", …). Only the
 * trailing upload noise is stripped — meaningful song words are untouched.
 */
export function normalizeTitle(title: string): string {
  let t = (title || '').toLowerCase()
  t = t.replace(
    /\s*[([](?:official|lyrics?|lyric video|music video|audio|video|visualizer|mv|live|performance|remaster(?:ed)?(?:\s+\d{4})?|hd|hq|4k|cover|acoustic|slowed|reverb|sped up|nightcore|explicit|clean)[^)\]]*[)\]]/g,
    '',
  )
  t = t.replace(/\s*[([]?(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]?$/g, '')
  t = t.replace(/\s*[-–|].*$/g, '')
  return t.replace(/[^a-z0-9]+/g, '')
}

/** Primary credited artist used only for recommendation-spacing policy. */
export function normalizeArtist(artist: string): string {
  const primary = (artist || '').split(/,|&|\b(?:feat\.?|ft\.?|featuring|with)\b/i)[0].trim()
  return primary.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function artistKey(track: Track): string {
  return normalizeArtist(track.artist) || `unknown:${track.id}`
}

export interface DiscoveryBlock {
  /** Track ids already known: current, user queue, discovery queue, history. */
  ids: Set<string>
  /** Normalized titles already in the session (current + both queues). */
  titles: Set<string>
  /** Artist occupancy in current + visible discovery, never the explicit queue. */
  artistCounts?: Map<string, number>
  /** Last current/discovery artist, used to avoid adjacent recommendations. */
  lastArtist?: string
}

/**
 * Picks unknown recommendations while retaining provider relevance order where
 * possible. At most two visible current/discovery entries share a primary
 * artist, and a different available artist is always selected before another
 * consecutive entry from the same artist. Explicit user queue entries are not
 * passed through this policy and remain untouched.
 */
export function pickDiscoveryCandidates(candidates: Track[], block: DiscoveryBlock, limit = 20): Track[] {
  const seenTitles = new Set<string>()
  const eligible: Track[] = []
  for (const track of dedupeTracks(candidates)) {
    if (!track?.id || block.ids.has(track.id)) continue
    const title = normalizeTitle(track.title)
    if (title && (block.titles.has(title) || seenTitles.has(title))) continue
    seenTitles.add(title)
    eligible.push(track)
  }

  const out: Track[] = []
  const artistCounts = new Map(block.artistCounts ?? [])
  let lastArtist = block.lastArtist ?? ''
  while (eligible.length > 0 && out.length < limit) {
    let selected = eligible.findIndex((track) => {
      const artist = artistKey(track)
      return (artistCounts.get(artist) ?? 0) < DISCOVERY_ARTIST_LIMIT && artist !== lastArtist
    })
    if (selected < 0) {
      selected = eligible.findIndex((track) => (
        (artistCounts.get(artistKey(track)) ?? 0) < DISCOVERY_ARTIST_LIMIT
      ))
    }
    if (selected < 0) break

    const [track] = eligible.splice(selected, 1)
    const artist = artistKey(track)
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1)
    lastArtist = artist
    out.push(track)
  }
  return out
}
