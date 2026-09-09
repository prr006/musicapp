/**
 * Normalizes a title so that different uploads of the same song compare equal
 * ("Believer", "Believer (Official Video)", "Believer - Lyrics", …). Only the
 * trailing upload noise is stripped — meaningful song words are untouched.
 */
export function normalizeTitle(title: string): string {
  let t = (title || '').toLowerCase()
  t = t.replace(
    /\s*[([](?:official|lyrics?|lyric video|music video|full (?:video|audio|song|lyrics?)|video song|audio|video|visualizer|mv|live|performance|remaster(?:ed)?(?:\s+\d{4})?|hd|hq|4k|cover|acoustic|slowed|reverb|sped up|nightcore|explicit|clean)[^)\]]*[)\]]/g,
    '',
  )
  t = t.replace(/\s*[([]?(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]?$/g, '')
  t = t.replace(/\s*[-–|].*$/g, '')
  return t.replace(/[^a-z0-9]+/g, '')
}

