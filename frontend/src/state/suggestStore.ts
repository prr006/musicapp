import { create } from 'zustand'
import { backend } from '../bridge/backend'
import type { SearchResponse, Track } from '../bridge/types'

/**
 * Search typeahead suggestions, fed by the real search provider.
 *
 * Rules enforced here (and covered by tests):
 *  - debounced: a keystroke never fires a request immediately
 *  - stale-safe: each request carries a generation token; a slow response for
 *    "bel" can never overwrite a newer query's suggestions
 *  - cheap: the dropdown is fed from the same provider the results page uses,
 *    so suggestions are real songs/videos/artists/albums — never fabricated.
 */

export type SuggestionKind = 'song' | 'video' | 'artist' | 'album' | 'history'

export interface Suggestion {
  key: string
  label: string
  sub: string
  kind: SuggestionKind
  artwork?: string
  track?: Track
  artistName?: string
  albumKey?: string
}

export interface SuggestState {
  items: Suggestion[]
  status: 'idle' | 'loading' | 'ready'
}

export const useSuggestStore = create<SuggestState>(() => ({ items: [], status: 'idle' }))

const set = useSuggestStore.setState

const DEBOUNCE_MS = 200
const MIN_LENGTH = 1
const MAX_ITEMS = 8

let generation = 0
let timer: ReturnType<typeof setTimeout> | null = null

function toSuggestions(res: SearchResponse): Suggestion[] {
  const songs = (res.songs ?? []).map(
    (t): Suggestion => ({ key: `s:${t.id}`, label: t.title, sub: t.artist, kind: 'song', artwork: t.artwork, track: t }),
  )
  const videos = (res.videos ?? []).map(
    (t): Suggestion => ({ key: `v:${t.id}`, label: t.title, sub: t.artist, kind: 'video', artwork: t.artwork, track: t }),
  )
  const artists = (res.artists ?? []).map(
    (a): Suggestion => ({ key: `a:${a.id}`, label: a.name, sub: 'Artist', kind: 'artist', artwork: a.artwork, artistName: a.name }),
  )
  const albums = (res.albums ?? []).map(
    (al): Suggestion => ({ key: `al:${al.id}`, label: al.title, sub: al.artist, kind: 'album', artwork: al.artwork, albumKey: al.id }),
  )
  return [...songs, ...videos, ...artists, ...albums].slice(0, MAX_ITEMS)
}

export const suggest = {
  /** Debounced suggestion fetch. Safe to call on every keystroke. */
  request(query: string): void {
    const q = query.trim()
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (q.length < MIN_LENGTH) {
      generation += 1
      set({ items: [], status: 'idle' })
      return
    }
    const token = ++generation
    set({ status: 'loading' })
    timer = setTimeout(() => {
      timer = null
      void backend()
        .search(q, '')
        .then((res) => {
          if (token !== generation) return
          set({ items: toSuggestions(res), status: 'ready' })
        })
        .catch(() => {
          if (token !== generation) return
          set({ items: [], status: 'ready' })
        })
    }, DEBOUNCE_MS)
  },

  /** Closes the dropdown and invalidates any in-flight request. */
  clear(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    generation += 1
    set({ items: [], status: 'idle' })
  },
}
