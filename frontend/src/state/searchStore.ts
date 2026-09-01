import { create } from 'zustand'
import { backend } from '../bridge/backend'
import type { SearchResponse } from '../bridge/types'
import { library } from './libraryStore'

export type SearchStatus = 'idle' | 'loading' | 'results' | 'empty' | 'error'

export interface SearchState {
  query: string
  submitted: string
  filter: string
  status: SearchStatus
  results: SearchResponse | null
  error: string | null
}

export const useSearchStore = create<SearchState>(() => ({
  query: '',
  submitted: '',
  filter: '',
  status: 'idle',
  results: null,
  error: null,
}))

const set = useSearchStore.setState
const get = useSearchStore.getState

// Guards against out-of-order responses: only the newest query may write.
let generation = 0

export const search = {
  setQuery(query: string): void {
    set({ query })
  },

  setFilter(filter: string): void {
    set({ filter })
    const q = get().submitted
    if (q) void search.run(q, filter)
  },

  clear(): void {
    generation += 1
    set({ query: '', submitted: '', status: 'idle', results: null, error: null })
  },

  async run(query: string, filter = get().filter): Promise<void> {
    const trimmed = query.trim()
    if (!trimmed) {
      search.clear()
      return
    }
    const token = ++generation
    set({ query: trimmed, submitted: trimmed, status: 'loading', error: null })
    try {
      const results = await backend().search(trimmed, filter)
      if (token !== generation) return
      const count =
        (results.songs?.length ?? 0) +
        (results.videos?.length ?? 0) +
        (results.albums?.length ?? 0) +
        (results.artists?.length ?? 0)
      set({ status: count > 0 ? 'results' : 'empty', results })
      if (count > 0) void library.addSearchTerm(trimmed)
    } catch (err) {
      if (token !== generation) return
      const message = err instanceof Error ? err.message : 'Couldn\u2019t reach YouTube.'
      set({ status: 'error', error: message, results: null })
    }
  },

  retry(): void {
    const q = get().submitted
    if (q) void search.run(q)
  },
}
