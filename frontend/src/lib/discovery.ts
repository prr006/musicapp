import type { Track } from '../bridge/types'
import { dedupeTracks } from './queue'

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

export interface DiscoveryBlock {
  /** Track ids already known: current, user queue, discovery queue, history. */
  ids: Set<string>
  /** Normalized titles already in the session (current + both queues). */
  titles: Set<string>
}

/**
 * Picks discovery candidates that are neither already known nor repeated
 * variants of the same song, preferring diversity. It deliberately does NOT
 * reject a track merely for sharing the current artist — related music can
 * legitimately come from the same artist.
 */
export function pickDiscoveryCandidates(candidates: Track[], block: DiscoveryBlock, limit = 20): Track[] {
  const out: Track[] = []
  const seenTitles = new Set<string>()
  for (const t of dedupeTracks(candidates)) {
    if (!t || !t.id || block.ids.has(t.id)) continue
    const key = normalizeTitle(t.title)
    if (key && (block.titles.has(key) || seenTitles.has(key))) continue
    seenTitles.add(key)
    out.push(t)
    if (out.length >= limit) break
  }
  return out
}
