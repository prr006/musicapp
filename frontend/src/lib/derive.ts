import type { Album, Artist, Track } from '../bridge/types'

/**
 * Albums and artists are derived from the metadata the provider actually gave
 * us. Tracks without an album simply do not appear under Albums — nothing is
 * invented to make the page look fuller.
 */

export function albumKey(track: Track): string {
  return `${track.album.toLowerCase()}|${primaryArtist(track.artist).toLowerCase()}`
}

export function primaryArtist(artist: string): string {
  return artist.split(/,| & | x /i)[0]?.trim() ?? artist
}

export function deriveAlbums(tracks: Track[]): Album[] {
  const map = new Map<string, Album>()
  for (const track of tracks) {
    if (!track.album?.trim()) continue
    const key = albumKey(track)
    const existing = map.get(key)
    if (existing) {
      existing.tracks!.push(track)
      if (!existing.artwork && track.artwork) existing.artwork = track.artwork
      continue
    }
    map.set(key, {
      id: key,
      title: track.album,
      artist: primaryArtist(track.artist),
      artwork: track.artwork,
      year: '',
      tracks: [track],
    })
  }
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title))
}

export function deriveArtists(tracks: Track[]): Artist[] {
  const map = new Map<string, Artist>()
  for (const track of tracks) {
    const name = primaryArtist(track.artist)
    if (!name) continue
    const key = name.toLowerCase()
    const existing = map.get(key)
    if (existing) {
      existing.tracks!.push(track)
      if (!existing.artwork && track.artwork) existing.artwork = track.artwork
      continue
    }
    map.set(key, { id: key, name, artwork: track.artwork, tracks: [track], albums: [] })
  }
  for (const artist of map.values()) {
    artist.albums = deriveAlbums(artist.tracks ?? [])
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function findAlbum(tracks: Track[], key: string): Album | null {
  return deriveAlbums(tracks).find((a) => a.id === key) ?? null
}

export function findArtist(tracks: Track[], name: string): Artist | null {
  const key = name.toLowerCase()
  return deriveArtists(tracks).find((a) => a.id === key) ?? null
}
