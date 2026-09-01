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
import type { Track } from '../bridge/types'
import { defaultSettings } from '../lib/defaults'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { usePlayerStore } from '../state/playerStore'
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
    getDiagnostics: vi.fn(),
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
  it('walks search → single-click play → mini player → queue → EOF advance', async () => {
    stubBackend()
    render(<App />)

    // Home shows a real empty state rather than fabricated content.
    expect(screen.getByText(/Your library starts here/i)).toBeInTheDocument()

    // Search through the real search field.
    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'night{enter}')
    await waitFor(() => expect(screen.getByText('Nightfall')).toBeInTheDocument())

    // Single click plays.
    await userEvent.click(screen.getByRole('button', { name: /Play Nightfall/i }))
    await waitFor(() => expect(usePlayerStore.getState().current?.id).toBe(a.id))
    expect(usePlayerStore.getState().status).toBe('playing')

    // Mini player reflects the current track.
    const player = document.querySelector('.player') as HTMLElement
    expect(within(player).getByText('Nightfall')).toBeInTheDocument()
    expect(within(player).getByText('Halcyon')).toBeInTheDocument()

    // Queue panel lists what is coming next.
    await userEvent.click(within(player).getByRole('button', { name: 'Queue' }))
    const panel = await screen.findByRole('complementary', { name: /Play queue/i })
    expect(within(panel).getByText('Paper Lanterns')).toBeInTheDocument()

    // Natural end of file advances exactly once.
    act(() => {
      playback.engine.el.dispatchEvent(new Event('ended'))
    })
    await waitFor(() => expect(usePlayerStore.getState().current?.id).toBe(b.id))
    expect(usePlayerStore.getState().index).toBe(1)
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
})
