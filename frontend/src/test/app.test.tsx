/**
 * Application-level smoke test: boots the real App shell against the fixture
 * backend and walks the primary user journey — search, single-click play,
 * mini player, queue, like, EOF advance — through the real stores, the real
 * playback controller and the real engine.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { setBackend, type Backend } from '../bridge/backend'
import type { SearchResponse, Track } from '../bridge/types'
import { defaultSettings } from '../lib/defaults'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { usePlayerStore } from '../state/playerStore'
import { useSearchStore } from '../state/searchStore'
import { useUIStore } from '../state/uiStore'

function song(id: string, title: string): Track {
  return {
    id: `yt:${id}`, sourceId: id, source: 'youtube', url: '', title, artist: 'Halcyon',
    album: 'Blue Hours', artwork: `http://img/${id}.jpg`, duration: 120, explicit: false,
  }
}

const a = song('a', 'Nightfall')
const b = song('b', 'Paper Lanterns')

let liked: Track[] = []

function stubBackend(): Backend {
  liked = []
  const be = {
    isNative: false,
    getState: vi.fn(async () => ({
      settings: defaultSettings(), liked: [], playlists: [], history: [], searchHistory: [], session: null, version: 1,
    })),
    getDiagnostics: vi.fn(async () => ({
      appVersion: '0.0.0', goVersion: 'go1.21', platform: 'linux', dataDir: '/tmp',
      streamProxy: 'off', resolver: { installed: false, path: '', version: '', message: '' },
      resolverBinary: '', mediaKeys: 'off', tray: 'on',
    })),
    search: vi.fn(async () => ({ query: 'night', songs: [a, b], videos: [], albums: [], artists: [], provider: 'ytmusic' })),
    getPlayable: vi.fn(async (t: Track) => ({
      trackId: t.id, url: `http://local/${t.sourceId}`, mimeType: 'audio/mp4', duration: 120, bitrate: 128, expiresAt: 0,
    })),
    getLyrics: vi.fn(async (q: { trackId: string }) => ({
      trackId: q.trackId, source: 'lrclib', synced: true,
      lines: [{ time: 0, text: 'first line' }, { time: 60, text: 'second line' }],
      plain: '', instrumental: false, offset: 0, matchedTitle: '', matchedArtist: '',
    })),
    saveSettings: vi.fn(async (s) => s),
    setLiked: vi.fn(async (t: Track, on: boolean) => {
      liked = on ? [t] : []
      return liked
    }),
    recordPlay: vi.fn(async (t: Track) => [{ track: t, playedAt: Date.now() }]),
    clearHistory: vi.fn(async () => {}),
    addSearchTerm: vi.fn(async () => ['night']),
    removeSearchTerm: vi.fn(async () => []),
    clearSearchHistory: vi.fn(async () => {}),
    libraryTracks: vi.fn(async () => []),
    saveSession: vi.fn(async () => {}),
    clearSession: vi.fn(async () => {}),
    createPlaylist: vi.fn(async (name: string, tracks: Track[]) => ({
      id: 'pl1', name, description: '', tracks, createdAt: 0, updatedAt: 0,
    })),
    renamePlaylist: vi.fn(),
    deletePlaylist: vi.fn(async () => {}),
    addTracksToPlaylist: vi.fn(),
    removeTrackFromPlaylist: vi.fn(),
    reorderPlaylist: vi.fn(),
    duplicatePlaylist: vi.fn(),
    installResolver: vi.fn(),
    setNowPlaying: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
  } as unknown as Backend
  setBackend(be)
  return be
}

beforeEach(() => {
  useLibraryStore.setState({ ready: true, loadError: null, settings: defaultSettings(), liked: [], playlists: [], history: [], searchHistory: [] })
  usePlayerStore.setState({
    queue: [], autoQueue: [], index: -1, current: null, status: 'idle', error: null,
    shuffle: false, repeat: 'off', volume: 1, muted: false, speed: 1, playingFrom: 'queue', contextLabel: '',
  })
  useUIStore.setState({ route: { name: 'home' }, history: [], future: [], queueOpen: false, nowPlayingOpen: false, lyricsOpen: false, toasts: [], resolverError: null, resolverProgress: null })
})

describe('MELO application', () => {
  it('walks search → single-click play → mini player → queue → autoplay advance', async () => {
    stubBackend()
    render(<App />)

    // Home shows a real empty state rather than fabricated content.
    expect(screen.getByText(/Your library starts here/i)).toBeInTheDocument()

    // Search through the real search field.
    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'night{enter}')
    await waitFor(() => expect(screen.getByText('Nightfall')).toBeInTheDocument())

    // Single click plays ONLY the chosen track.
    await userEvent.click(screen.getByRole('button', { name: /Play Nightfall/i }))
    await waitFor(() => expect(usePlayerStore.getState().current?.id).toBe(a.id))
    expect(usePlayerStore.getState().status).toBe('playing')
    // Search-result siblings must NOT become the queue.
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual([a.id])

    // Mini player reflects the current track.
    const player = document.querySelector('.player') as HTMLElement
    expect(within(player).getByText('Nightfall')).toBeInTheDocument()
    expect(within(player).getByText('Halcyon')).toBeInTheDocument()

    // The global queue panel separates the explicit queue from autoplay.
    await userEvent.click(within(player).getByRole('button', { name: 'Queue' }))
    const panel = await screen.findByRole('complementary', { name: /Play queue/i })
    // "Paper Lanterns" is an autoplay suggestion, not a queued search sibling.
    await waitFor(() => expect(within(panel).getByText('Paper Lanterns')).toBeInTheDocument())

    // Natural end of file advances exactly once, into autoplay.
    act(() => {
      playback.engine.el.dispatchEvent(new Event('ended'))
    })
    await waitFor(() => expect(usePlayerStore.getState().current?.id).toBe(b.id))
    expect(usePlayerStore.getState().playingFrom).toBe('autoplay')
  })

  it('does not mutate current track or queues while searching unrelated terms', async () => {
    stubBackend()
    render(<App />)

    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'night{enter}')
    await userEvent.click(await screen.findByRole('button', { name: /Play Nightfall/i }))
    await waitFor(() => expect(usePlayerStore.getState().status).toBe('playing'))
    // Let the autoplay pipeline settle so we have a stable baseline.
    await waitFor(() => expect(usePlayerStore.getState().autoQueue.map((t) => t.id)).toEqual([b.id]))
    const currentBefore = usePlayerStore.getState().current?.id
    const queueBefore = usePlayerStore.getState().queue.map((t) => t.id)
    const autoBefore = usePlayerStore.getState().autoQueue.map((t) => t.id)

    // A fresh search must never rewrite the session.
    const input = screen.getByRole('textbox', { name: 'Search' })
    await userEvent.clear(input)
    await userEvent.type(input, 'lantern{enter}')
    await waitFor(() => expect(screen.getByText('Paper Lanterns')).toBeInTheDocument())

    expect(usePlayerStore.getState().current?.id).toBe(currentBefore)
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual(queueBefore)
    expect(usePlayerStore.getState().autoQueue.map((t) => t.id)).toEqual(autoBefore)
  })

  it('keeps one global queue across every route', async () => {
    stubBackend()
    render(<App />)

    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'night{enter}')
    await userEvent.click(await screen.findByRole('button', { name: /Play Nightfall/i }))
    await waitFor(() => expect(usePlayerStore.getState().status).toBe('playing'))

    const extra = song('c', 'Ember Glow')
    act(() => {
      playback.addToQueue([extra])
    })
    const queue = () => usePlayerStore.getState().queue.map((t) => t.id)
    expect(queue()).toEqual([a.id, extra.id])

    // The same single queue survives navigation across the whole app.
    for (const label of ['Your Library', 'Search', 'Settings', 'Home']) {
      await userEvent.click(screen.getByRole('button', { name: label }))
      expect(queue()).toEqual([a.id, extra.id])
    }
  })

  it('keeps the sidebar reachable while the expanded Now Playing is open', async () => {
    stubBackend()
    render(<App />)

    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'night{enter}')
    await userEvent.click(await screen.findByRole('button', { name: /Play Nightfall/i }))
    await waitFor(() => expect(usePlayerStore.getState().status).toBe('playing'))

    // Expand Now Playing.
    const player = document.querySelector('.player') as HTMLElement
    await userEvent.click(within(player).getByRole('button', { name: 'Open now playing' }))
    expect(useUIStore.getState().nowPlayingOpen).toBe(true)
    expect(screen.getByRole('region', { name: 'Now playing' })).toBeInTheDocument()

    // The overlay lives inside the main column, never over the sidebar.
    const np = screen.getByRole('region', { name: 'Now playing' })
    expect(np.closest('main')).toBeInTheDocument()
    expect(np.closest('nav')).toBeNull()

    // Sidebar navigation takes effect immediately from the expanded view.
    await userEvent.click(screen.getByRole('button', { name: 'Your Library' }))
    expect(useUIStore.getState().route).toEqual({ name: 'library', tab: 'songs' })

    await userEvent.click(screen.getByRole('button', { name: 'Search' }))
    expect(useUIStore.getState().route).toEqual({ name: 'search' })

    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(useUIStore.getState().route).toEqual({ name: 'settings' })

    await userEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect(useUIStore.getState().route).toEqual({ name: 'home' })

    // Player controls still receive clicks after navigation.
    await userEvent.click(within(player).getByRole('button', { name: 'Queue' }))
    expect(useUIStore.getState().queueOpen).toBe(true)
  })

  it('keeps like state in the library and the mini player in sync', async () => {
    const be = stubBackend()
    render(<App />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'night{enter}')
    await userEvent.click(await screen.findByRole('button', { name: /Play Nightfall/i }))
    const player = document.querySelector('.player') as HTMLElement
    await userEvent.click(within(player).getByRole('button', { name: /Add to Liked Songs/i }))
    await waitFor(() => expect(be.setLiked).toHaveBeenCalled())
    expect(useLibraryStore.getState().liked.map((t) => t.id)).toEqual([a.id])
  })

  it('shows synced lyrics for the current track and clears them on switch', async () => {
    stubBackend()
    render(<App />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'night{enter}')
    await userEvent.click(await screen.findByRole('button', { name: /Play Nightfall/i }))
    const player = document.querySelector('.player') as HTMLElement
    await userEvent.click(within(player).getByRole('button', { name: 'Lyrics' }))
    expect(await screen.findByText('first line')).toBeInTheDocument()

    await act(async () => {
      await playback.next()
    })
    await waitFor(() => expect(usePlayerStore.getState().current?.id).toBe(b.id))
    // Lyrics belong to the new track only.
    await waitFor(() => expect(screen.getByText('first line')).toBeInTheDocument())
    expect(document.querySelectorAll('.lyric-line').length).toBe(2)
  })

  it('creates a playlist from the queue and lists it in the sidebar', async () => {
    const be = stubBackend()
    render(<App />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'night{enter}')
    await userEvent.click(await screen.findByRole('button', { name: /Play Nightfall/i }))
    await act(async () => {
      await library.createPlaylist('Evening', [a, b])
    })
    expect(be.createPlaylist).toHaveBeenCalledWith('Evening', [a, b])
    await waitFor(() => expect(screen.getByRole('button', { name: /Evening/ })).toBeInTheDocument())
  })

  it('reports a backend failure instead of pretending to work', async () => {
    useLibraryStore.setState({ loadError: 'Couldn’t load your library — the MELO backend isn’t running.' })
    stubBackend()
    render(<App />)
    expect(screen.getByRole('alert')).toHaveTextContent(/backend isn’t running/)
  })

  it('keeps search usable after a playback resolution failure', async () => {
    const be = stubBackend()
    // First search: normal full shape. After the resolver fails, the next search
    // returns the null-section shape real responses can have (yt-dlp fallback /
    // video-only). The search page must still render instead of going blank.
    be.search = vi
      .fn()
      .mockResolvedValueOnce({ query: 'night', songs: [a, b], videos: [], albums: [], artists: [], provider: 'ytmusic' })
      .mockResolvedValue({ query: 'night', songs: [a, b], videos: null, albums: null, artists: null, provider: 'yt-dlp' } as unknown as SearchResponse) as unknown as Backend['search']
    be.getPlayable = vi.fn().mockRejectedValue(new Error('this song has no playable audio stream')) as unknown as Backend['getPlayable']

    render(<App />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'night{enter}')
    await waitFor(() => expect(screen.getByText('Nightfall')).toBeInTheDocument())

    // Clicking a result now fails at the resolver.
    await userEvent.click(screen.getByRole('button', { name: /Play Nightfall/i }))
    await waitFor(() => expect(usePlayerStore.getState().status).toBe('error'))

    // Search again: the page must render results, not a blank screen.
    const input = screen.getByRole('textbox', { name: 'Search' })
    await userEvent.clear(input)
    await userEvent.type(input, 'night{enter}')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Songs' })).toBeInTheDocument())
    expect(screen.getAllByText('Nightfall').length).toBeGreaterThan(0)
    expect(useSearchStore.getState().status).toBe('results')
  })
})
