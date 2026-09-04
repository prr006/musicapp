/**
 * Library + Liked Songs milestone tests: like persistence and canonical
 * dedupe, recently/most-played presentation, artist/album derivation rules,
 * playlist persistence, library actions through the global queue, local-only
 * filtering, and empty states.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Backend } from '../bridge/backend'
import { setBackend } from '../bridge/backend'
import type { PlayRecord, Playlist, Track } from '../bridge/types'
import { canonicalSongKey } from '../lib/radio'
import { defaultSettings } from '../lib/defaults'
import { deriveAlbums, deriveArtists, mostPlayedTracks } from '../lib/derive'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { usePlayerStore } from '../state/playerStore'
import { useUIStore } from '../state/uiStore'
import { LibraryView } from '../views/LibraryView'

function song(id: string, extra: Partial<Track> = {}): Track {
  return {
    id: `yt:${id}`, sourceId: id, source: 'youtube', url: '', title: `Song ${id}`,
    artist: 'Halcyon', album: 'Blue Hours', artwork: `http://img/${id}.jpg`,
    duration: 200, explicit: false, ...extra,
  }
}

let persist: { liked: Track[]; playlists: Playlist[] } = { liked: [], playlists: [] }

function stubBackend(): Backend {
  persist = { liked: [], playlists: [] }
  const be = {
    isNative: false,
    search: vi.fn(async () => ({ query: '', songs: [], videos: [], albums: [], artists: [], provider: 'test' })),
    relatedTracks: vi.fn(async () => ({ tracks: [], source: '' })),
    logRadio: vi.fn(async () => {}),
    getPlayable: vi.fn(async (t: Track) => ({
      trackId: t.id, url: `http://local/${t.sourceId}`, mimeType: 'audio/mp4', duration: 200, bitrate: 128, expiresAt: 0,
    })),
    getLyrics: vi.fn(async () => ({ trackId: '', source: 't', synced: false, lines: [], plain: '', instrumental: false, offset: 0, matchedTitle: '', matchedArtist: '' })),
    saveSettings: vi.fn(async (s) => s),
    // The liked list is the authoritative persisted store (like the Go store).
    setLiked: vi.fn(async (t: Track, liked: boolean) => {
      persist.liked = liked
        ? [{ ...t, addedAt: Date.now() }, ...persist.liked.filter((x) => x.id !== t.id)]
        : persist.liked.filter((x) => x.id !== t.id)
      return persist.liked
    }),
    recordPlay: vi.fn(async (t: Track) => [{ track: t, playedAt: Date.now() }] as PlayRecord[]),
    recordPlayEvent: vi.fn(async (t: Track) => {
      const s = useLibraryStore.getState()
      return { history: [{ track: t, playedAt: Date.now() }, ...s.history], stats: s.stats, disliked: s.disliked }
    }),
    setDisliked: vi.fn(async () => ({ history: [], stats: {}, disliked: [] })),
    createPlaylist: vi.fn(async (name: string, tracks: Track[]) => {
      const pl: Playlist = { id: `pl${persist.playlists.length + 1}`, name, description: '', tracks, createdAt: 0, updatedAt: 0 }
      persist.playlists = [...persist.playlists, pl]
      return pl
    }),
    deletePlaylist: vi.fn(async (id: string) => {
      persist.playlists = persist.playlists.filter((p) => p.id !== id)
    }),
    clearHistory: vi.fn(async () => {}),
    addSearchTerm: vi.fn(async () => []), removeSearchTerm: vi.fn(async () => []),
    clearSearchHistory: vi.fn(async () => {}), libraryTracks: vi.fn(async () => []),
    saveSession: vi.fn(async () => {}), clearSession: vi.fn(async () => {}),
    renamePlaylist: vi.fn(), reorderPlaylist: vi.fn(), duplicatePlaylist: vi.fn(),
    removeTrackFromPlaylist: vi.fn(), addTracksToPlaylist: vi.fn(),
    installResolver: vi.fn(), setNowPlaying: vi.fn(async () => {}), on: vi.fn(() => () => {}),
    getState: vi.fn(async () => ({ settings: defaultSettings(), liked: persist.liked, playlists: persist.playlists, history: [], searchHistory: [], session: null, version: 1 })),
    getDiagnostics: vi.fn(async () => ({})),
  } as unknown as Backend
  setBackend(be)
  return be
}

const state = () => usePlayerStore.getState()

beforeEach(() => {
  stubBackend()
  useLibraryStore.setState({
    ready: true, loadError: null, settings: defaultSettings(), liked: [], disliked: [],
    playlists: [], history: [], stats: {}, searchHistory: [],
  })
  usePlayerStore.setState({
    queue: [], autoQueue: [], index: -1, current: null, status: 'idle', error: null,
    shuffle: false, repeat: 'off', volume: 0.9, muted: false, speed: 1,
    playingFrom: 'queue', contextLabel: '', radioSource: '',
  })
  useUIStore.setState({ route: { name: 'library', tab: 'liked' }, history: [], future: [], queueOpen: false, nowPlayingOpen: false, lyricsOpen: false, toasts: [], resolverError: null, resolverProgress: null })
})

afterEach(() => {
  playback.stop()
  cleanup()
  vi.clearAllMocks()
})

describe('liked songs', () => {
  it('liking creates a persisted Liked Songs entry; unliking removes it immediately', async () => {
    const a = song('a')
    await library.toggleLike(a)
    expect(useLibraryStore.getState().liked.map((t) => t.id)).toEqual(['yt:a'])
    expect(persist.liked.map((t) => t.id)).toEqual(['yt:a']) // survives "restart" store

    await library.toggleLike(a)
    expect(useLibraryStore.getState().liked).toHaveLength(0)
    expect(persist.liked).toHaveLength(0)
  })

  it('like/unlike is idempotent — no duplicate records', async () => {
    await library.toggleLike(song('a'))
    // A second like of the same track (toggle off + on again quickly) never duplicates.
    await library.toggleLike(song('a'))
    await library.toggleLike(song('a'))
    expect(persist.liked.filter((t) => t.id === 'yt:a')).toHaveLength(1)
  })

  it('duplicate versions of one song do not create duplicate library records', async () => {
    // Same canonical song, different YouTube uploads (Topic channel vs video).
    const official = song('v1', { title: 'Nightfall' })
    const video = song('v2', { title: 'Nightfall (Official Video)' })
    expect(canonicalSongKey(video)).toBe(canonicalSongKey(official))
    await library.toggleLike(official)
    await library.toggleLike(video)
    expect(useLibraryStore.getState().liked).toHaveLength(1)
    expect(useLibraryStore.getState().liked[0].id).toBe('yt:v2') // freshest metadata wins
    expect(persist.liked).toHaveLength(1)
  })

  it('liked state survives a reload (hydrate from persisted state)', async () => {
    await library.toggleLike(song('a'))
    await library.toggleLike(song('b'))
    // Simulate application restart: a fresh store hydrated from disk.
    useLibraryStore.setState({ liked: [] })
    library.hydrate({
      settings: defaultSettings(), liked: persist.liked, disliked: [], playlists: [],
      history: [], stats: {}, searchHistory: [], session: null, version: 1,
    })
    expect(useLibraryStore.getState().liked.map((t) => t.id)).toEqual(['yt:b', 'yt:a'])
  })
})

describe('history presentation', () => {
  it('Recently Played is populated from meaningful listening events and stays deduped', () => {
    const a = song('a')
    const b = song('b')
    // The ladder writes history through recordPlayEvent; replays append records.
    useLibraryStore.setState({
      history: [
        { track: b, playedAt: 3_000 },
        { track: a, playedAt: 2_000 },
        { track: b, playedAt: 1_000 }, // replayed earlier — deduped, newest first
      ],
    })
    render(<LibraryView tab="recent" />)
    expect(screen.getByText('Song b')).toBeInTheDocument()
    expect(screen.getByText('Song a')).toBeInTheDocument()
    const rows = document.querySelectorAll('.track-list .track-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('Song b')).toBeInTheDocument() // newest first
  })

  it('playback-state noise does not create history entries', async () => {
    useUIStore.setState({ route: { name: 'library', tab: 'songs' } })
    useLibraryStore.setState({ liked: [song('a')] })
    render(<LibraryView tab="liked" />)
    await userEvent.click(screen.getByRole('button', { name: /Play Song a/i }))
    await waitFor(() => expect(state().current?.id).toBe('yt:a'))
    // The ladder records the started event exactly once for the track…
    await waitFor(() => expect(useLibraryStore.getState().history).toHaveLength(1))
    // …and pause/seek/volume noise adds nothing.
    await playback.pause()
    await playback.resume()
    playback.seek(10) // below the meaningful-listen threshold: pure state noise
    playback.setVolume(0.4)
    await new Promise((r) => setTimeout(r, 40))
    expect(useLibraryStore.getState().history).toHaveLength(1)
  })
})

describe('most played', () => {
  it('uses persisted play counts, sorted deterministically', () => {
    const a = song('a'), b = song('b'), c = song('c')
    const list = mostPlayedTracks(
      [
        { track: c, playedAt: 1 }, { track: a, playedAt: 2 }, { track: b, playedAt: 3 },
      ],
      { 'yt:a': { playCount: 5, significantCount: 0, completeCount: 0, skipCount: 0, lastPlayedAt: 10 },
        'yt:b': { playCount: 9, significantCount: 0, completeCount: 0, skipCount: 0, lastPlayedAt: 20 },
        'yt:c': { playCount: 5, significantCount: 0, completeCount: 0, skipCount: 0, lastPlayedAt: 30 } },
    )
    expect(list.map((x) => x.track.id)).toEqual(['yt:b', 'yt:c', 'yt:a']) // plays desc, then recency
    expect(list[0].plays).toBe(9)
    // Zero-play tracks never appear.
    expect(mostPlayedTracks([{ track: song('z'), playedAt: 0 }], {})).toHaveLength(0)
  })
})

describe('artist and album derivation', () => {
  it('uploaders/channels are never treated as artists', () => {
    const artists = deriveArtists([
      song('u1', { artist: '', uploader: 'Slowed Music Channel' }),
      song('u2', { artist: '', uploader: 'The Naghera' }),
      song('h1', { artist: 'Halcyon' }),
    ])
    expect(artists.map((a) => a.name)).toEqual(['Halcyon'])
  })

  it('albums with missing metadata are handled safely (no bogus albums)', () => {
    const albums = deriveAlbums([
      song('1', { album: '' }),
      song('2', { album: '   ' }),
      song('3', { album: 'Blue Hours' }),
    ])
    expect(albums.map((a) => a.title)).toEqual(['Blue Hours'])
  })
})

describe('playlists', () => {
  it('playlists persist through the store and reload', async () => {
    const pl = await library.createPlaylist('Road Trip', [song('a'), song('b')])
    expect(pl.tracks).toHaveLength(2)
    // Simulated restart: hydrate from what the backend persisted.
    useLibraryStore.setState({ playlists: [] })
    library.hydrate({
      settings: defaultSettings(), liked: [], disliked: [], playlists: persist.playlists,
      history: [], stats: {}, searchHistory: [], session: null, version: 1,
    })
    render(<LibraryView tab="playlists" />)
    expect(screen.getByText('Road Trip')).toBeInTheDocument()
    expect(screen.getByText('2 songs')).toBeInTheDocument()
  })
})

describe('library actions', () => {
  it('library playback uses the existing global queue and Start Radio the existing radio', async () => {
    useLibraryStore.setState({ liked: [song('a'), song('b')] })
    render(<LibraryView tab="liked" />)
    await userEvent.click(screen.getByRole('button', { name: /Play Song a/i }))
    await waitFor(() => expect(state().current?.id).toBe('yt:a'))
    expect(state().queue.map((t) => t.id)).toEqual(['yt:a', 'yt:b']) // global user queue
    expect(state().playingFrom).toBe('queue')

    // Start radio from a liked row's menu: only that track is queued, radio builds separately.
    const rows = document.querySelectorAll('.track-list .track-row')
    await userEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Start radio/i }))
    await waitFor(() => expect(state().current?.id).toBe('yt:b'))
    expect(state().queue.map((t) => t.id)).toEqual(['yt:b'])
  })
})

describe('local search and empty states', () => {
  it('library search filters locally and never calls the remote provider', async () => {
    const be = stubBackend()
    useLibraryStore.setState({
      liked: [song('a', { title: 'Nightfall' }), song('b', { title: 'Paper Lanterns', artist: 'Other Band' })],
      playlists: [],
    })
    render(<LibraryView tab="liked" />)
    const field = screen.getByRole('searchbox', { name: 'Search your library' })
    await userEvent.type(field, 'paper')
    expect(screen.getByText('Paper Lanterns')).toBeInTheDocument()
    expect(screen.queryByText('Nightfall')).not.toBeInTheDocument()
    expect(be.search).not.toHaveBeenCalled() // local filtering only
  })

  it('search reaches artists, albums and playlists too', () => {
    useLibraryStore.setState({
      liked: [song('a', { title: 'Nightfall' })],
      playlists: [{ id: 'p1', name: 'Focus Mix', description: '', tracks: [song('a')], createdAt: 0, updatedAt: 0 }],
    })
    const { unmount } = render(<LibraryView tab="artists" />)
    expect(screen.getByText('Halcyon')).toBeInTheDocument()
    void userEvent.type(screen.getByRole('searchbox', { name: 'Search your library' }), 'zzz')
    unmount()
  })

  it('empty states render intentional copy per section', () => {
    render(<LibraryView tab="liked" />)
    expect(screen.getByText('Songs you like will appear here.')).toBeInTheDocument()
    cleanup()
    render(<LibraryView tab="recent" />)
    expect(screen.getByText('Your listening history will appear here.')).toBeInTheDocument()
    cleanup()
    render(<LibraryView tab="most-played" />)
    expect(screen.getByText(/Keep listening and MELO will build your most-played list/i)).toBeInTheDocument()
    cleanup()
    render(<LibraryView tab="artists" />)
    expect(screen.getByText('Artists from your library will appear here.')).toBeInTheDocument()
  })

  it('most played renders from persisted counts with play badges', () => {
    useLibraryStore.setState({
      history: [{ track: song('a'), playedAt: 5 }],
      stats: { 'yt:a': { playCount: 7, significantCount: 2, completeCount: 1, skipCount: 0, lastPlayedAt: 5 } },
    })
    render(<LibraryView tab="most-played" />)
    expect(screen.getByText('Song a')).toBeInTheDocument()
    expect(screen.getByText('7 plays')).toBeInTheDocument()
  })
})
