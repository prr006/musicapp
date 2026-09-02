import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Artwork } from '../components/Artwork'
import { TrackRow } from '../components/TrackRow'
import { SearchView } from '../views/SearchView'
import { setBackend, type Backend } from '../bridge/backend'
import type { SearchResponse, Track } from '../bridge/types'
import { defaultSettings } from '../lib/defaults'
import { useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { useSearchStore, search } from '../state/searchStore'
import { usePlayerStore } from '../state/playerStore'

const song: Track = {
  id: 'yt:a', sourceId: 'a', source: 'youtube', url: '', title: 'Nightfall', artist: 'Halcyon',
  album: 'Blue Hours', artwork: 'http://img/a.jpg', duration: 200, explicit: false,
}

function stub(overrides: Partial<Backend> = {}): Backend {
  const be = {
    isNative: false,
    search: vi.fn(async () => ({ query: 'q', songs: [song], videos: [], albums: [], artists: [], provider: 'ytmusic' })),
    setLiked: vi.fn(async () => [song]),
    addSearchTerm: vi.fn(async () => ['q']),
    getPlayable: vi.fn(async () => ({ trackId: song.id, url: 'http://local/a', mimeType: 'audio/mp4', duration: 200, bitrate: 128, expiresAt: 0 })),
    getLyrics: vi.fn(async () => ({ trackId: song.id, source: 't', synced: false, lines: [], plain: '', instrumental: false, offset: 0, matchedTitle: '', matchedArtist: '' })),
    recordPlay: vi.fn(async () => []),
    setDisliked: vi.fn(async () => ({ history: [], stats: {}, disliked: [song] })),
    saveSession: vi.fn(async () => {}),
    setNowPlaying: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as Backend
  setBackend(be)
  return be
}

beforeEach(() => {
  useLibraryStore.setState({ ready: true, loadError: null, settings: defaultSettings(), liked: [], disliked: [], stats: {}, playlists: [], history: [], searchHistory: [] })
  useSearchStore.setState({ query: '', submitted: '', filter: '', status: 'idle', results: null, error: null })
  usePlayerStore.setState({ queue: [], autoQueue: [], index: -1, current: null, status: 'idle', error: null, shuffle: false, repeat: 'off', volume: 1, muted: false, speed: 1, playingFrom: 'queue', contextLabel: '' })
})

describe('TrackRow interactions', () => {
  it('plays with a single click', async () => {
    stub()
    const onPlay = vi.fn()
    render(<TrackRow track={song} index={0} onPlay={onPlay} />)
    await userEvent.click(screen.getByRole('button', { name: /Play Nightfall/i }))
    expect(onPlay).toHaveBeenCalledTimes(1)
  })

  it('keeps the like button independent from playback', async () => {
    const be = stub()
    const onPlay = vi.fn()
    render(<TrackRow track={song} index={0} onPlay={onPlay} />)
    await userEvent.click(screen.getByRole('button', { name: /Add to Liked Songs/i }))
    expect(onPlay).not.toHaveBeenCalled()
    await waitFor(() => expect(be.setLiked).toHaveBeenCalledWith(song, true))
  })

  it('keeps add-to-queue independent from playback', async () => {
    stub()
    const onPlay = vi.fn()
    const spy = vi.spyOn(playback, 'addToQueue')
    render(<TrackRow track={song} index={0} onPlay={onPlay} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add to queue' }))
    expect(onPlay).not.toHaveBeenCalled()
    expect(spy).toHaveBeenCalledWith([song])
    spy.mockRestore()
  })

  it('opens the context menu without starting playback', async () => {
    stub()
    const onPlay = vi.fn()
    render(<TrackRow track={song} index={0} onPlay={onPlay} />)
    await userEvent.click(screen.getByRole('button', { name: 'More options' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(onPlay).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: /Play next/i })).toBeInTheDocument()
  })

  it('is reachable and operable from the keyboard', async () => {
    stub()
    const onPlay = vi.fn()
    render(<TrackRow track={song} index={0} onPlay={onPlay} />)
    const row = screen.getByRole('button', { name: /Play Nightfall/i })
    row.focus()
    await userEvent.keyboard('{Enter}')
    expect(onPlay).toHaveBeenCalled()
  })
})

describe('SearchView states', () => {
  it('shows the idle prompt, then results', async () => {
    stub()
    render(<SearchView />)
    expect(screen.getByText(/Find something to play/i)).toBeInTheDocument()

    await act(async () => { await search.run('night') })
    await waitFor(() => expect(screen.getByText('Nightfall')).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Songs' })).toBeInTheDocument()
  })

  it('shows a distinct empty state', async () => {
    stub({ search: vi.fn(async () => ({ query: 'zz', songs: [], videos: [], albums: [], artists: [], provider: 'ytmusic' })) })
    render(<SearchView />)
    await act(async () => { await search.run('zz') })
    await waitFor(() => expect(screen.getByText('No results')).toBeInTheDocument())
  })

  it('shows an actionable error with retry', async () => {
    const be = stub({ search: vi.fn().mockRejectedValue(new Error('Couldn’t reach YouTube.')) })
    render(<SearchView />)
    await act(async () => { await search.run('boom') })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Couldn’t reach YouTube/))
    await userEvent.click(screen.getByRole('button', { name: /Retry search/i }))
    expect(be.search).toHaveBeenCalledTimes(2)
  })

  it('renders results when the provider returns null sections (yt-dlp fallback shape)', async () => {
    // The Go backend marshals nil slices as JSON `null`; the yt-dlp fallback and
    // video-only InnerTube responses have no albums/artists lists at all.
    // This used to crash the render (blank page) via `null.length`.
    stub({
      search: vi.fn(async () => ({
        query: 'x', songs: [song], videos: null, albums: null, artists: null, provider: 'yt-dlp',
      } as unknown as SearchResponse)),
    })
    render(<SearchView />)
    await act(async () => { await search.run('x') })
    await waitFor(() => expect(screen.getByText('Nightfall')).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Songs' })).toBeInTheDocument()
    expect(useSearchStore.getState().status).toBe('results')
  })

  it('renders real provider artwork', async () => {
    stub()
    render(<SearchView />)
    await act(async () => { await search.run('night') })
    const img = await screen.findByAltText('Nightfall')
    expect(img).toHaveAttribute('src', 'http://img/a.jpg')
  })
})

describe('Artwork fit strategy', () => {
  const size = (img: HTMLElement, w: number, h: number) => {
    Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true })
    Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true })
  }

  it('letterboxes a 16:9 video thumbnail instead of cropping it', () => {
    render(<Artwork src="http://img/v.jpg" alt="Video" />)
    const img = screen.getByAltText('Video')
    size(img, 1280, 720)
    act(() => fireEvent.load(img))
    expect(img.className).toContain('contain')
    expect(img.closest('.artwork')?.querySelector('.artwork-fill')).toBeInTheDocument()
  })

  it('keeps square album art clean with a cover fit and no blur layer', () => {
    render(<Artwork src="http://img/sq.jpg" alt="Square" />)
    const img = screen.getByAltText('Square')
    size(img, 600, 600)
    act(() => fireEvent.load(img))
    expect(img.className).not.toContain('contain')
    expect(img.closest('.artwork')?.querySelector('.artwork-fill')).not.toBeInTheDocument()
  })

  it('degrades to initials when there is no artwork', () => {
    render(<Artwork alt="Nightfall" />)
    const fallback = document.querySelector('.artwork .fallback')
    expect(fallback).toBeInTheDocument()
    expect(fallback).toHaveTextContent('NI')
  })
})

describe('radio actions in the song menu', () => {
  it('offers start radio, play next, add to queue and don\u2019t-recommend', async () => {
    stub()
    const onPlay = vi.fn()
    render(<TrackRow track={song} index={0} onPlay={onPlay} />)
    await userEvent.click(screen.getByRole('button', { name: 'More options' }))
    const menu = await screen.findByRole('menu')
    for (const label of [/Start radio/i, /Play next/i, /Add to queue/i, /Don\u2019t recommend/i]) {
      expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument()
    }
    // Playback is never triggered by opening the menu.
    expect(onPlay).not.toHaveBeenCalled()
  })

  it('start radio plays only the chosen track and builds autoplay separately', async () => {
    const other: Track = { ...song, id: 'yt:b', sourceId: 'b', title: 'Paper Lanterns' }
    stub({ search: vi.fn(async () => ({ query: 'q', songs: [song, other], videos: [], albums: [], artists: [], provider: 'ytmusic' })) })
    const onPlay = vi.fn()
    render(<TrackRow track={song} index={0} onPlay={onPlay} />)
    await userEvent.click(screen.getByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Start radio/i }))
    await waitFor(() => expect(usePlayerStore.getState().current?.id).toBe(song.id))
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual([song.id])
    await waitFor(() => expect(usePlayerStore.getState().autoQueue.length).toBeGreaterThan(0))
    expect(usePlayerStore.getState().playingFrom).toBe('queue')
  })

  it('don\u2019t-recommend records feedback without touching playback', async () => {
    const be = stub()
    const onPlay = vi.fn()
    render(<TrackRow track={song} index={0} onPlay={onPlay} />)
    await userEvent.click(screen.getByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Don\u2019t recommend/i }))
    await waitFor(() => expect(be.setDisliked).toHaveBeenCalledWith(song, true))
    expect(onPlay).not.toHaveBeenCalled()
  })

  it('renders exactly one add-to-queue control per row — no duplicates, no no-ops', async () => {
    stub()
    render(<TrackRow track={song} index={0} onPlay={() => {}} />)
    expect(screen.getAllByRole('button', { name: 'Add to queue' })).toHaveLength(1)
    // The like control is also singular and functional.
    expect(screen.getAllByRole('button', { name: /Add to Liked Songs/i })).toHaveLength(1)
  })
})
