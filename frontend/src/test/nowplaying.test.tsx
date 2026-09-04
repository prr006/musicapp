/**
 * Now Playing + Lyrics polish tests. Everything runs through the real App
 * shell, the real playback controller, the real engine and the real stores —
 * there is no second playback surface to accidentally test instead.
 *
 * Numbered test names map to the milestone spec (NOW PLAYING 1–12, LYRICS
 * 13–23, NAVIGATION/OVERLAYS 24–29); regressions 30–33 are the pre-existing
 * suites, which must keep passing unchanged alongside this file.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { setBackend, type Backend } from '../bridge/backend'
import type { LyricsQuery, LyricsResult, PlayRecord, Track } from '../bridge/types'
import { defaultSettings } from '../lib/defaults'
import { useLibraryStore } from '../state/libraryStore'
import { useLyricsStore } from '../state/lyricsStore'
import { playback } from '../state/playback'
import { usePlayerStore } from '../state/playerStore'
import { positionChannel } from '../state/positionChannel'
import { ui, useUIStore } from '../state/uiStore'

function song(id: string, extra: Partial<Track> = {}): Track {
  return {
    id: `yt:${id}`, sourceId: id, source: 'youtube', url: '', title: `Song ${id}`,
    artist: 'Halcyon', album: 'Blue Hours', artwork: `http://img/${id}.jpg`,
    duration: 120, explicit: false, ...extra,
  }
}

const a = song('a', { title: 'Nightfall' })
const b = song('b', { title: 'Paper Lanterns' })
const related = song('rel1', { title: 'Related One', artist: 'Other Artist', album: '' })

/** Two uploads of the same song — the case song-centric matching must survive. */
const officialVideo = song('v1', { title: 'Nightfall (Official Video)' })
const audioVersion = song('v2', { title: 'Nightfall (Audio)' })

const SYNCED_LINES = [
  { time: 0, text: 'first line' },
  { time: 30, text: 'second line' },
  { time: 60, text: 'third line' },
]

function syncedResult(q: LyricsQuery, lines = SYNCED_LINES): LyricsResult {
  return {
    trackId: q.trackId, source: 'lrclib', synced: true, lines,
    plain: '', instrumental: false, offset: 0, matchedTitle: q.title, matchedArtist: '',
  }
}

let lyricsImpl: (q: LyricsQuery) => Promise<LyricsResult>
let playEvents: { id: string; event: string }[]

function stubBackend() {
  const relatedTracks = vi.fn(async (): Promise<{ tracks: Track[]; source: string }> => ({
    tracks: [related], source: 'ytmusic-next',
  }))
  const getPlayable = vi.fn(async (t: Track) => ({
    trackId: t.id, url: `http://local/${t.sourceId}`, mimeType: 'audio/mp4', duration: 120, bitrate: 128, expiresAt: 0,
  }))
  const getLyrics = vi.fn(async (q: LyricsQuery) => lyricsImpl(q))
  const recordPlayEvent = vi.fn(async (t: Track, event: string) => {
    playEvents.push({ id: t.id, event })
    const s = useLibraryStore.getState()
    return { history: [{ track: t, playedAt: Date.now() }, ...s.history], stats: s.stats, disliked: s.disliked }
  })
  const be = {
    isNative: false,
    getState: vi.fn(async () => ({
      settings: defaultSettings(), liked: [], playlists: [], history: [], searchHistory: [], session: null, version: 1,
    })),
    getDiagnostics: vi.fn(async () => ({ appVersion: '0.0.0', goVersion: 'go1.21', platform: 'linux', dataDir: '/tmp', streamProxy: 'off', resolver: { installed: false, path: '', version: '', message: '' }, resolverBinary: '', mediaKeys: 'off', tray: 'on' })),
    search: vi.fn(async () => ({ query: '', songs: [], videos: [], albums: [], artists: [], provider: 'test' })),
    relatedTracks,
    logRadio: vi.fn(async () => {}),
    getPlayable,
    getLyrics,
    saveSettings: vi.fn(async (s) => s),
    setLiked: vi.fn(async (t: Track, on: boolean) => (on ? [t] : [])),
    setDisliked: vi.fn(async (t: Track, on: boolean) => {
      const s = useLibraryStore.getState()
      return { history: s.history, stats: s.stats, disliked: on ? [t] : [] }
    }),
    recordPlay: vi.fn(async (t: Track) => [{ track: t, playedAt: Date.now() }] as PlayRecord[]),
    recordPlayEvent,
    clearHistory: vi.fn(async () => {}),
    addSearchTerm: vi.fn(async () => []), removeSearchTerm: vi.fn(async () => []),
    clearSearchHistory: vi.fn(async () => {}), libraryTracks: vi.fn(async () => []),
    saveSession: vi.fn(async () => {}), clearSession: vi.fn(async () => {}),
    createPlaylist: vi.fn(), renamePlaylist: vi.fn(), deletePlaylist: vi.fn(async () => {}),
    addTracksToPlaylist: vi.fn(), removeTrackFromPlaylist: vi.fn(), reorderPlaylist: vi.fn(), duplicatePlaylist: vi.fn(),
    installResolver: vi.fn(), setNowPlaying: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
  } as unknown as Backend
  setBackend(be)
  return { backend: be, relatedTracks, getPlayable, getLyrics, recordPlayEvent }
}

const playerState = () => usePlayerStore.getState()

async function start(track: Track, tracks: Track[] = [track]) {
  await act(async () => {
    await playback.play(track, { tracks })
  })
}

async function openExpanded(withLyrics = false) {
  await act(async () => {
    if (withLyrics) ui.toggleLyrics(true)
    else ui.toggleNowPlaying(true)
  })
  return npSection()
}

/** The expanded player section. Selected by class: a track row’s equalizer
 *  span carries aria-label “Now playing” too, so label queries are ambiguous. */
function npSection() {
  return document.querySelector('section.now-playing') as HTMLElement
}

function tickMedia(seconds: number) {
  act(() => {
    playback.engine.el.currentTime = seconds
    playback.engine.el.dispatchEvent(new Event('timeupdate'))
  })
}

beforeEach(() => {
  stubBackend()
  lyricsImpl = (q) => Promise.resolve(syncedResult(q))
  playEvents = []
  useLibraryStore.setState({
    ready: true, loadError: null, settings: defaultSettings(), liked: [], disliked: [],
    playlists: [], history: [], stats: {}, searchHistory: [],
  })
  usePlayerStore.setState({
    queue: [], autoQueue: [], index: -1, current: null, status: 'idle', error: null,
    shuffle: false, repeat: 'off', volume: 1, muted: false, speed: 1, playingFrom: 'queue', contextLabel: '', radioSource: '',
  })
  useUIStore.setState({ route: { name: 'home' }, history: [], future: [], queueOpen: false, nowPlayingOpen: false, lyricsOpen: false, toasts: [], resolverError: null, resolverProgress: null })
  useLyricsStore.setState({ trackId: null, status: 'idle', result: null, error: null })
  positionChannel.reset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('NOW PLAYING', () => {
  it('1. renders the current track metadata (title, artist, album)', async () => {
    render(<App />)
    await start(a)
    await openExpanded()
    const np = npSection()
    expect(within(np).getByText('Nightfall')).toBeInTheDocument()
    expect(within(np).getByRole('button', { name: 'Halcyon' })).toBeInTheDocument()
    expect(within(np).getByRole('button', { name: 'Blue Hours' })).toBeInTheDocument()
  })

  it('2. falls back to initials when artwork is missing or fails to load', async () => {
    render(<App />)
    await start(song('noart', { title: 'Ghost Track', artwork: '' }))
    await openExpanded()
    let np = npSection()
    let art = np.querySelector('.np-art') as HTMLElement
    expect(art.querySelector('img')).toBeNull()
    expect(art.querySelector('.fallback')?.textContent).toBe('GT')

    // A URL that fails at runtime degrades to the same fallback.
    cleanup()
    render(<App />)
    await start(song('badart', { title: 'Broken Art' }))
    await openExpanded()
    np = npSection()
    art = np.querySelector('.np-art') as HTMLElement
    fireEvent.error(art.querySelector('img') as HTMLElement)
    await waitFor(() => expect(art.querySelector('.fallback')?.textContent).toBe('BA'))
  })

  it('3. like state is synchronized between store, expanded player and mini player', async () => {
    render(<App />)
    await start(a)
    await openExpanded()
    const np = npSection()
    fireEvent.click(within(np).getByRole('button', { name: 'Like' }))
    await waitFor(() => expect(useLibraryStore.getState().liked.some((t) => t.id === a.id)).toBe(true))
    await waitFor(() => expect(within(np).getByRole('button', { name: 'Unlike' })).toHaveAttribute('aria-pressed', 'true'))
    // The mini player heart reflects the same single source of truth.
    const mini = document.querySelector('.player-bar') as HTMLElement
    expect(within(mini).getByRole('button', { name: 'Remove from Liked Songs' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('4. dislike / don’t-recommend state is synchronized immediately', async () => {
    render(<App />)
    await start(a)
    await openExpanded()
    const np = npSection()
    fireEvent.click(within(np).getByRole('button', { name: /don.t recommend this song/i }))
    await waitFor(() => expect(useLibraryStore.getState().disliked.some((t) => t.id === a.id)).toBe(true))
    const btn = within(np).getByRole('button', { name: /allow recommendations again/i })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('5. play/pause drives the global playback controller, not a second one', async () => {
    const mocks = stubBackend()
    render(<App />)
    await start(a)
    await openExpanded()
    const np = npSection()
    expect(within(np).getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(mocks.getPlayable).toHaveBeenCalledTimes(1)

    fireEvent.click(within(np).getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(playerState().status).toBe('paused'))
    expect(within(np).getByRole('button', { name: 'Play' })).toBeInTheDocument()

    // Previous follows existing player semantics: deep into the song it restarts.
    tickMedia(70)
    fireEvent.click(within(np).getByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(playback.engine.el.currentTime).toBe(0))
  })

  it('6. next respects the User Queue before Autoplay', async () => {
    render(<App />)
    await start(a, [a, b])
    await waitFor(() => expect(playerState().autoQueue.length).toBeGreaterThan(0))
    await act(async () => {
      await playback.next()
    })
    expect(playerState().current?.id).toBe(b.id)
    expect(playerState().playingFrom).toBe('queue')
    await act(async () => {
      await playback.next()
    })
    // User queue exhausted → the MELO autoplay track continues the session.
    await waitFor(() => expect(playerState().current?.id).toBe(related.id))
  })

  it('7. Queue opens the one global QueuePanel, never a duplicate list', async () => {
    render(<App />)
    await start(a)
    await openExpanded()
    fireEvent.click(within(npSection()).getByRole('button', { name: 'Queue' }))
    const panels = screen.getAllByLabelText('Play queue')
    expect(panels).toHaveLength(1)
    const panel = within(panels[0])
    expect(panel.getByText(/now playing/i)).toBeInTheDocument()
    expect(panel.getByText(/up next/i)).toBeInTheDocument()
    expect(panel.getByText(/autoplay/i)).toBeInTheDocument()
    // Now Playing itself never embeds a second copy of the queue contents.
    expect(npSection().querySelectorAll('.track-row').length).toBe(0)
  })

  it('8. progress updates from real playback ticks', async () => {
    render(<App />)
    await start(a)
    await openExpanded()
    const np = npSection()
    await waitFor(() => expect(within(np).getByText('2:00')).toBeInTheDocument())
    tickMedia(45)
    await waitFor(() => expect(within(np).getByText('0:45')).toBeInTheDocument())
    // The duration readout can flip to the (correct) remaining time.
    fireEvent.mouseEnter(within(np).getAllByText('2:00')[0])
    expect(within(np).getByText('−1:15')).toBeInTheDocument()
    fireEvent.mouseLeave(within(np).getAllByText('−1:15')[0])
    expect(within(np).getByText('2:00')).toBeInTheDocument()
  })

  it('9. keyboard seek updates playback through the existing seek mechanism', async () => {
    render(<App />)
    await start(a)
    await openExpanded()
    const np = npSection()
    const scrubber = within(np).getByRole('slider', { name: 'Seek' })
    scrubber.focus()
    fireEvent.keyDown(scrubber, { key: 'ArrowRight' })
    await waitFor(() => expect(playback.engine.el.currentTime).toBe(5))
    await waitFor(() => expect(within(np).getByText('0:05')).toBeInTheDocument())
    expect(scrubber).toHaveAttribute('aria-valuenow', '5')
  })

  it('10. seeking never triggers discovery/radio regeneration', async () => {
    const mocks = stubBackend()
    render(<App />)
    await start(a)
    await waitFor(() => expect(mocks.relatedTracks).toHaveBeenCalled())
    const callsAfterStart = mocks.relatedTracks.mock.calls.length
    const seedBefore = playerState().radioSource
    act(() => {
      playback.seek(20)
      playback.seek(40)
      playback.seek(3)
    })
    tickMedia(90)
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.relatedTracks.mock.calls.length).toBe(callsAfterStart)
    expect(playerState().radioSource).toBe(seedBefore)
  })

  it('11. seeking never duplicates history events, including around the threshold', async () => {
    const mocks = stubBackend()
    render(<App />)
    await start(a)
    await waitFor(() => expect(playEvents.map((e) => e.event)).toContain('play_started'))
    // Cross the 30 s meaningful-listen threshold exactly once…
    tickMedia(45)
    await waitFor(() => expect(playEvents.filter((e) => e.event === 'played_significantly')).toHaveLength(1))
    // …then seek back and forth across it repeatedly: still exactly one.
    act(() => playback.seek(2))
    tickMedia(60)
    act(() => playback.seek(29))
    tickMedia(31)
    act(() => playback.seek(100))
    await act(async () => {
      await Promise.resolve()
    })
    expect(playEvents.filter((e) => e.event === 'played_significantly')).toHaveLength(1)
    expect(playEvents.filter((e) => e.event === 'play_started')).toHaveLength(1)
    expect(mocks.recordPlayEvent).toHaveBeenCalled()
  })

  it('12. mini player and expanded player stay synchronized', async () => {
    render(<App />)
    await start(a)
    await openExpanded()
    const np = npSection()
    const mini = document.querySelector('.player-bar') as HTMLElement

    // Shuffle flipped in the expanded player shows in the mini player.
    fireEvent.click(within(np).getByRole('button', { name: 'Shuffle' }))
    await waitFor(() => expect(playerState().shuffle).toBe(true))
    expect(within(mini).getByRole('button', { name: 'Shuffle' })).toHaveAttribute('aria-pressed', 'true')

    // Repeat too.
    fireEvent.click(within(np).getByRole('button', { name: /repeat off/i }))
    await waitFor(() => expect(playerState().repeat).toBe('all'))
    expect(within(mini).getByRole('button', { name: /repeat all/i })).toBeInTheDocument()

    // Pausing in the expanded player flips the mini player’s button.
    fireEvent.click(within(np).getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(within(mini).getByRole('button', { name: 'Play' })).toBeInTheDocument())

    // Liking from the mini player fills the expanded heart.
    fireEvent.click(within(mini).getByRole('button', { name: 'Add to Liked Songs' }))
    await waitFor(() => expect(within(np).getByRole('button', { name: 'Unlike' })).toHaveAttribute('aria-pressed', 'true'))
  })
})

describe('LYRICS', () => {
  async function openWithLyrics() {
    render(<App />)
    await start(a)
    await openExpanded(true)
    await waitFor(() => expect(screen.getByLabelText('Synced lyrics')).toBeInTheDocument())
    return screen.getByLabelText('Synced lyrics') as HTMLElement
  }

  it('13. song-centric matching survives version changes (stale answers never bleed)', async () => {
    const mocks = stubBackend()
    render(<App />)

    // A pending answer for the first version…
    let resolveFirst: ((r: LyricsResult) => void) | null = null
    lyricsImpl = (q) => {
      if (q.trackId === officialVideo.id) {
        return new Promise<LyricsResult>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve({ ...syncedResult(q), lines: [{ time: 0, text: 'audio version line' }] })
    }

    await start(officialVideo)
    await act(async () => {
      ui.toggleLyrics(true)
    })
    await start(audioVersion)
    await waitFor(() => expect(screen.getByText('audio version line')).toBeInTheDocument())

    // …resolving late must not overwrite the newer track’s lyrics.
    act(() => {
      resolveFirst?.(syncedResult({ trackId: officialVideo.id, title: 'Nightfall (Official Video)', artist: 'Halcyon', album: 'Blue Hours', duration: 120 }, [{ time: 0, text: 'stale official video line' }]))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText('stale official video line')).toBeNull()
    expect(screen.getByText('audio version line')).toBeInTheDocument()

    // Both versions sent their real song identity to the matcher.
    const titles = mocks.getLyrics.mock.calls.map((c) => (c[0] as LyricsQuery).title)
    expect(titles).toEqual(['Nightfall (Official Video)', 'Nightfall (Audio)'])
    const second = mocks.getLyrics.mock.calls[1][0] as LyricsQuery
    expect(second.artist).toBe('Halcyon')
    expect(second.album).toBe('Blue Hours')
    expect(second.duration).toBe(120)
  })

  it('14. timed lyrics auto-scroll to center the active line', async () => {
    const pane = await openWithLyrics()
    const scrollTo = vi.fn()
    pane.scrollTo = scrollTo as unknown as typeof pane.scrollTo

    act(() => positionChannel.setPosition(31)) // → second line becomes active
    await waitFor(() => expect(scrollTo.mock.calls.length).toBeGreaterThanOrEqual(1))
    expect(scrollTo.mock.calls.at(-1)?.[0]).toMatchObject({ behavior: 'smooth' })
    // Ticks within the same line never re-scroll.
    const calls = scrollTo.mock.calls.length
    act(() => positionChannel.setPosition(35))
    expect(scrollTo.mock.calls.length).toBe(calls)
  })

  it('15. the current lyric line is highlighted', async () => {
    await openWithLyrics()
    act(() => positionChannel.setPosition(31))
    const active = screen.getByText('second line')
    expect(active.className).toContain('active')
    expect(active).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('first line').className).toContain('passed')
  })

  it('16. clicking a lyric line seeks without touching radio, queue or history', async () => {
    const mocks = stubBackend()
    render(<App />)
    await start(a)
    await act(async () => {
      ui.toggleLyrics(true)
    })
    await waitFor(() => expect(screen.getByText('third line')).toBeInTheDocument())
    const callsBefore = mocks.relatedTracks.mock.calls.length
    const queueBefore = playerState().queue.map((t) => t.id)
    const indexBefore = playerState().index

    fireEvent.click(screen.getByText('third line'))
    await waitFor(() => expect(playback.engine.el.currentTime).toBe(60))
    expect(mocks.relatedTracks.mock.calls.length).toBe(callsBefore)
    expect(playerState().queue.map((t) => t.id)).toEqual(queueBefore)
    expect(playerState().index).toBe(indexBefore)
    // The seek crossing the threshold records the event once — never duplicates.
    await waitFor(() => expect(playEvents.filter((e) => e.event === 'played_significantly')).toHaveLength(1))
    expect(playEvents.filter((e) => e.event === 'completed')).toHaveLength(0)
  })

  it('17. manual scrolling suspends auto-follow instead of fighting the user', async () => {
    const pane = await openWithLyrics()
    const scrollTo = vi.fn()
    pane.scrollTo = scrollTo as unknown as typeof pane.scrollTo

    // Suspend before any new line transition: from here the pane must not scroll.
    fireEvent.wheel(pane)
    act(() => positionChannel.setPosition(61)) // → third line
    await act(async () => {
      await Promise.resolve()
    })
    // Follow stayed suspended: no scroll fight, and the pill is offered.
    expect(scrollTo).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Return to the current line' })).toBeInTheDocument()
    // The line is still highlighted while suspended.
    expect(screen.getByText('third line').className).toContain('active')
  })

  it('18. the return-to-current-line control resumes following', async () => {
    const pane = await openWithLyrics()
    const scrollTo = vi.fn()
    pane.scrollTo = scrollTo as unknown as typeof pane.scrollTo
    fireEvent.wheel(pane)
    await act(async () => {
      await Promise.resolve()
    })
    const resume = screen.getByRole('button', { name: 'Return to the current line' })
    fireEvent.click(resume)
    await waitFor(() => expect(scrollTo).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Return to the current line' })).toBeNull()
    // Following is active again: the next line change scrolls.
    const calls = scrollTo.mock.calls.length
    act(() => positionChannel.setPosition(61))
    await waitFor(() => expect(scrollTo.mock.calls.length).toBeGreaterThan(calls))
  })

  it('19. plain lyrics display safely without pretending to be synced', async () => {
    lyricsImpl = (q) =>
      Promise.resolve({ ...syncedResult(q), synced: false, lines: [], plain: 'la la la\nsecond row of plain text' })
    render(<App />)
    await start(a)
    await act(async () => {
      ui.toggleLyrics(true)
    })
    await waitFor(() => expect(screen.getByText(/second row of plain text/)).toBeInTheDocument())
    expect(document.querySelector('.lyric-plain')).toBeInTheDocument()
    expect(document.querySelectorAll('.lyric-line').length).toBe(0)
    expect(screen.queryByLabelText('Synced lyrics')).toBeNull()
  })

  it('20. instrumental lyrics show the instrumental state', async () => {
    lyricsImpl = (q) => Promise.resolve({ ...syncedResult(q), instrumental: true, lines: [], synced: false, plain: '' })
    render(<App />)
    await start(a)
    await act(async () => {
      ui.toggleLyrics(true)
    })
    await waitFor(() => expect(screen.getByText('Instrumental')).toBeInTheDocument())
    expect(screen.getByText('This track has no lyrics.')).toBeInTheDocument()
  })

  it('21. lyrics-unavailable shows the empty state, never a blank pane', async () => {
    lyricsImpl = () => Promise.reject(new Error('No lyrics found.'))
    render(<App />)
    await start(a)
    await act(async () => {
      ui.toggleLyrics(true)
    })
    await waitFor(() => expect(screen.getByText('No lyrics found')).toBeInTheDocument())
  })

  it('22. lyrics/network errors show the error state with the message', async () => {
    lyricsImpl = () => Promise.reject(new Error('connection reset by peer'))
    render(<App />)
    await start(a)
    await act(async () => {
      ui.toggleLyrics(true)
    })
    await waitFor(() => expect(screen.getByText('Lyrics unavailable')).toBeInTheDocument())
    expect(screen.getByText('connection reset by peer')).toBeInTheDocument()
  })

  it('23. malformed timing data is sanitized instead of crashing', async () => {
    lyricsImpl = (q) =>
      Promise.resolve({
        ...syncedResult(q),
        lines: [
          { time: Number.NaN, text: 'broken nan line' },
          { time: -4, text: 'broken negative line' },
          { time: 60, text: 'late line' },
          { time: 10, text: 'early line' },
        ] as LyricsResult['lines'],
      })
    render(<App />)
    await start(a)
    await act(async () => {
      ui.toggleLyrics(true)
    })
    await waitFor(() => expect(screen.getByText('early line')).toBeInTheDocument())
    // Invalid timestamps dropped; order repaired; highlighting still correct.
    expect(screen.queryByText('broken nan line')).toBeNull()
    expect(screen.queryByText('broken negative line')).toBeNull()
    act(() => positionChannel.setPosition(15))
    expect(screen.getByText('early line').className).toContain('active')

    // A “synced” result with only one usable timestamp is not pretended to be
    // synced — it degrades to plain text.
    cleanup()
    render(<App />)
    lyricsImpl = (q) => Promise.resolve({ ...syncedResult(q), lines: [{ time: 12, text: 'only timestamped line' }] })
    await start(b)
    await act(async () => {
      ui.toggleLyrics(true)
    })
    await waitFor(() => expect(screen.getByText('only timestamped line')).toBeInTheDocument())
    expect(screen.queryByLabelText('Synced lyrics')).toBeNull()
    expect(document.querySelector('.lyric-plain')).toBeInTheDocument()
  })
})

describe('NAVIGATION & OVERLAYS', () => {
  it('24. the sidebar stays clickable while Now Playing is expanded', async () => {
    render(<App />)
    await start(a)
    await openExpanded()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(useUIStore.getState().route.name).toBe('search'))
    // Navigation dismissed the overlay; the route is visible underneath.
    expect(document.querySelector('section.now-playing')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Search' })).toBeInTheDocument()
  })

  it('25. Home / Search / Library / Settings all remain reachable', async () => {
    render(<App />)
    await start(a)
    await openExpanded()

    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    await waitFor(() => expect(useUIStore.getState().route.name).toBe('home'))
    expect(document.querySelector('section.now-playing')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(useUIStore.getState().route.name).toBe('search'))

    fireEvent.click(screen.getByRole('button', { name: 'Your Library' }))
    await waitFor(() => expect(useUIStore.getState().route.name).toBe('library'))

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await waitFor(() => expect(useUIStore.getState().route.name).toBe('settings'))
    expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument()
  })

  it('26. the queue opens while Now Playing stays expanded', async () => {
    render(<App />)
    await start(a)
    await openExpanded()
    fireEvent.click(within(npSection()).getByRole('button', { name: 'Queue' }))
    expect(screen.getByLabelText('Play queue')).toBeInTheDocument()
    expect(npSection()).toBeInTheDocument()
    // Closing the queue leaves the expanded player alone.
    fireEvent.click(screen.getByRole('button', { name: 'Close queue' }))
    expect(screen.queryByLabelText('Play queue')).toBeNull()
    expect(npSection()).toBeInTheDocument()
  })

  it('27. lyrics open and close without losing the player', async () => {
    render(<App />)
    await start(a)
    await act(async () => {
      ui.toggleLyrics(true)
    })
    await waitFor(() => expect(screen.getByLabelText('Synced lyrics')).toBeInTheDocument())
    expect(npSection()).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle lyrics' }))
    await waitFor(() => expect(screen.queryByLabelText('Synced lyrics')).toBeNull())
    // The expanded player itself stays open, playback untouched.
    expect(npSection()).toBeInTheDocument()
    expect(usePlayerStore.getState().status).toBe('playing')
  })

  it('28. browser back/forward remains safe with the player open', async () => {
    render(<App />)
    await start(a)
    act(() => {
      ui.navigate({ name: 'search' })
      ui.navigate({ name: 'library', tab: 'songs' })
    })
    await openExpanded()
    act(() => {
      ui.back()
    })
    expect(useUIStore.getState().route.name).toBe('search')
    expect(useUIStore.getState().nowPlayingOpen).toBe(false)
    act(() => {
      ui.forward()
    })
    expect(useUIStore.getState().route.name).toBe('library')
    // Navigation never interrupted playback.
    expect(usePlayerStore.getState().status).toBe('playing')
  })

  it('29. closing overlays leaves no invisible overlay behind', async () => {
    render(<App />)
    await start(a)
    await openExpanded()
    fireEvent.click(within(npSection()).getByRole('button', { name: 'Queue' }))
    expect(screen.getByLabelText('Play queue')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('section.now-playing')).toBeNull())
    expect(screen.queryByLabelText('Play queue')).toBeNull()
    expect(document.querySelector('.now-playing')).toBeNull()

    // The app underneath is fully interactive again.
    fireEvent.click(screen.getByRole('button', { name: 'Your Library' }))
    await waitFor(() => expect(useUIStore.getState().route.name).toBe('library'))
    expect(usePlayerStore.getState().status).toBe('playing')
  })
})
