/**
 * Responsive-layout regression tests.
 *
 * jsdom has no real layout engine, so the LAYOUT POLICY is asserted against
 * its source of truth — global.css — and the shell STRUCTURE is asserted
 * against the rendered App. Together they lock the desktop-viewport
 * contract: the app surface expands with the window, the sidebar and the
 * full-width MiniPlayer keep their stable shells, the expanded Now Playing
 * scales with both width and height, and the queue overlay never regresses
 * to a fixed slab (nor breaks its stacking contract with Now Playing).
 */
// The stylesheet is the layout source of truth, so the contract is asserted
// against its text directly. (Read from disk: vitest's `css: false` config
// makes `?raw` CSS imports empty — see test/node-api.d.ts for the shims.)
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { setBackend, type Backend } from '../bridge/backend'
import type { Track } from '../bridge/types'
import { defaultSettings } from '../lib/defaults'
import { useLibraryStore } from '../state/libraryStore'
import { usePlayerStore } from '../state/playerStore'
import { useUIStore } from '../state/uiStore'

const css = readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8')

/** Extracts the declaration block of the FIRST rule for a selector. */
function rule(selector: string): string {
  const idx = css.indexOf(`${selector} {`)
  expect(idx, `selector ${selector} exists in global.css`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', idx)
  return css.slice(idx, end + 1)
}

/** Extracts a media query's full block (brace-matched, nested rules kept). */
function mediaBlock(condition: string): string {
  const idx = css.indexOf(`@media (${condition}) {`)
  expect(idx, `@media (${condition}) exists in global.css`).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = idx + mediaRaw(condition).length - 1; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(idx, i + 1)
    }
  }
  throw new Error(`unbalanced media block: ${condition}`)
}

function mediaRaw(condition: string): string {
  return `@media (${condition}) {`
}

describe('layout: stylesheet contract (desktop viewport usage)', () => {
  it('the stylesheet is structurally sound', () => {
    expect(css.split('{').length).toBe(css.split('}').length)
  })

  it('the primary app surface has NO centered max-width card', () => {
    const page = rule('.page')
    expect(page).not.toContain('max-width: 1400px')
    expect(page).not.toContain('margin: 0 auto')
    // Side padding is fluid instead: grows with the viewport, bounded.
    expect(page).toContain('clamp(28px, 3vw, 56px)')
  })

  it('the shell keeps a stable sidebar and a full-width MiniPlayer', () => {
    expect(rule(':root')).toContain('--sidebar-w: 248px')
    expect(rule('.app')).toContain('grid-template-columns: var(--sidebar-w) 1fr')
    // The player bar spans every grid column — full application width.
    expect(rule('.player-bar')).toContain('grid-column: 1 / -1')
  })

  it('card grids adapt column count AND card size to the viewport', () => {
    expect(rule('.card-grid')).toContain('minmax(clamp(168px, 12vw, 216px), 1fr)')
  })

  it('detail heroes grow on large screens (artwork + title)', () => {
    expect(rule('.detail-head .artwork')).toContain('clamp(208px, 15vw, 272px)')
    expect(rule('.detail-meta h1')).toContain('clamp(36px, 2.6vw, 48px)')
  })

  it('track lists and rows fill the available width', () => {
    // Rows are width: 100% grids with fluid fractions — no fixed row width.
    const row = rule('.track-row')
    expect(row).toContain('width: 100%')
    expect(row).not.toContain('max-width')
  })

  it('the MiniPlayer scrubber uses the wider centre track', () => {
    expect(rule('.scrubber-row')).toContain('max-width: 780px')
  })
})

describe('layout: expanded Now Playing', () => {
  it('is a true two-column composition: artwork track + metadata column', () => {
    const col = rule('.np-art-col')
    // The artwork track is a fluid share of the viewport WIDTH…
    expect(col).toContain('minmax(280px, min(44vw, 560px))')
    expect(col).toContain('minmax(0, 1fr)') // …beside the metadata/controls column
    expect(col).toContain('clamp(36px, 4.5vw, 80px)') // fluid inter-column gap
    // …while the square cover is bounded by the viewport HEIGHT too: its
    // width may never exceed the vertical room, so short windows shrink it
    // instead of clipping the controls.
    expect(rule('.np-art')).toContain('min(100%, calc(100vh - 240px))')
    const body = rule('.np-body')
    expect(body).toContain('clamp(32px, 4vw, 64px)') // fluid gap
    expect(body).toContain('minmax(320px, 440px)') // lyrics column beside the composition
  })

  it('the scrubber spans the metadata column — the 780px cap is mini-player only', () => {
    expect(rule('.scrubber-row')).toContain('max-width: 780px')
    expect(css).toContain('.now-playing .scrubber-row {')
    const idx = css.indexOf('.now-playing .scrubber-row {')
    expect(css.slice(idx, css.indexOf('}', idx))).toContain('max-width: none')
  })

  it('the player reflows beside the open queue panel instead of hiding under it', () => {
    expect(css).toContain('.now-playing.with-queue .np-body {')
    const idx = css.indexOf('.now-playing.with-queue .np-body {')
    expect(css.slice(idx, css.indexOf('}', idx))).toContain('clamp(320px, 30vw, 420px)')
  })

  it('the spacious tier (1600px+) visibly enlarges the player', () => {
    const spacious = mediaBlock('min-width: 1600px')
    expect(spacious).toContain('minmax(320px, min(46vw, 680px))') // bigger artwork track
    expect(spacious).toContain('clamp(30px, 2.2vw, 42px)') // bigger title
    expect(spacious).toContain('.np-buttons .play-btn')
    // Pages benefit too: roomier cards and detail heroes.
    expect(spacious).toContain('clamp(184px, 11vw, 240px)')
    expect(spacious).toContain('clamp(232px, 13vw, 300px)')
  })

  it('compact tier (900–1199px): lyrics mode stacks beside the pane; solo keeps the split', () => {
    const compact = mediaBlock('max-width: 1199px')
    expect(compact).toContain('display: flex') // stacked player column with lyrics open
    expect(compact).toContain('calc(100vh - 520px)') // …still height-bounded
    expect(compact).toContain('justify-content: center') // controls re-centre when stacked
  })

  it('collapses to a single column at narrow widths', () => {
    const narrow = mediaBlock('max-width: 900px')
    expect(narrow).toContain('.np-body')
    expect(narrow).toContain('.np-art-col') // the composition itself stacks
    expect(narrow).toContain('grid-template-columns: minmax(0, 1fr)')
  })

  it('lyrics keep a readable line length on ultra-wide columns', () => {
    expect(rule('.lyrics-pane')).toContain('max-width: 820px')
  })
})

describe('layout: queue panel overlay', () => {
  it('has a responsive width, not a fixed slab', () => {
    const panel = rule('.panel')
    expect(panel).toContain('width: clamp(320px, 30vw, 420px)')
    expect(panel).not.toContain('width: 372px')
  })

  it('keeps the stacking contract above Now Playing (z-index regression)', () => {
    expect(rule('.panel')).toContain('z-index: 80')
    expect(rule('.now-playing')).toContain('z-index: 70')
  })
})

describe('layout: breakpoints', () => {
  it('uses fluid sizing first and only the intended breakpoints', () => {
    const queries = [...css.matchAll(/@media \(([^)]+)\)/g)].map((m) => m[1])
    expect(queries).toEqual(
      expect.arrayContaining(['min-width: 1600px', 'max-width: 1199px', 'max-width: 900px', 'prefers-reduced-motion: reduce']),
    )
    // Guard against hard-coded breakpoint sprawl: exactly these four. The
    // tiers between them (≥1920, 1200–1599, 900–1199) stay fluid via
    // clamp()/vw sizing rather than piling up more breakpoints.
    expect(queries).toHaveLength(4)
  })
})

/* ---------------- shell structure (rendered App) ---------------- */

function song(id: string): Track {
  return {
    id: `yt:${id}`, sourceId: id, source: 'youtube', url: '', title: `Song ${id}`,
    artist: 'Halcyon', album: 'Blue Hours', artwork: `http://img/${id}.jpg`, duration: 120, explicit: false,
  }
}

function stubBackend(): Backend {
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
    search: vi.fn(async () => ({ query: '', songs: [song('a')], videos: [], albums: [], artists: [], provider: 'ytmusic' })),
    relatedTracks: vi.fn(async () => ({ tracks: [], source: '' })),
    logRadio: vi.fn(async () => {}),
    getPlayable: vi.fn(async (t: Track) => ({
      trackId: t.id, url: `http://local/${t.sourceId}`, mimeType: 'audio/mp4', duration: 120, bitrate: 128, expiresAt: 0,
    })),
    getLyrics: vi.fn(async () => ({
      trackId: 'x', source: 'lrclib', synced: false, lines: [], plain: '', instrumental: false,
      offset: 0, matchedTitle: '', matchedArtist: '',
    })),
    saveSettings: vi.fn(async (s) => s),
    setLiked: vi.fn(async () => []),
    recordPlay: vi.fn(async () => []),
    recordPlayEvent: vi.fn(async () => ({ history: [], stats: {}, disliked: [] })),
    getTaste: vi.fn(async () => ({ history: [], stats: {}, disliked: [] })),
    setDisliked: vi.fn(async () => ({ history: [], stats: {}, disliked: [] })),
    clearHistory: vi.fn(async () => {}),
    addSearchTerm: vi.fn(async () => []),
    removeSearchTerm: vi.fn(async () => []),
    clearSearchHistory: vi.fn(async () => {}),
    libraryTracks: vi.fn(async () => []),
    saveSession: vi.fn(async () => {}),
    clearSession: vi.fn(async () => {}),
    createPlaylist: vi.fn(),
    renamePlaylist: vi.fn(),
    deletePlaylist: vi.fn(),
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
  vi.clearAllMocks()
  stubBackend()
  useLibraryStore.setState({
    ready: true, loadError: null, settings: defaultSettings(), liked: [], disliked: [],
    stats: {}, playlists: [], history: [], searchHistory: [],
  })
  usePlayerStore.setState({
    queue: [], autoQueue: [], index: -1, current: null, status: 'idle', error: null,
    shuffle: false, repeat: 'off', volume: 1, muted: false, speed: 1, sleepTimer: null,
    playingFrom: 'queue', contextLabel: '', radioSource: '',
  })
  useUIStore.setState({
    route: { name: 'home' }, history: [], future: [], queueOpen: false,
    nowPlayingOpen: false, lyricsOpen: false, toasts: [], resolverError: null, resolverProgress: null,
  })
})

describe('layout: rendered shell structure', () => {
  it('is sidebar + main + full-width player, with pages directly in the content area', async () => {
    const { container } = render(<App />)
    const app = container.querySelector('.app')
    expect(app).toBeTruthy()
    expect(app!.querySelector(':scope > .sidebar')).toBeTruthy()
    const main = app!.querySelector(':scope > .main')
    expect(main).toBeTruthy()
    expect(app!.querySelector(':scope > .player-bar')).toBeTruthy() // MiniPlayer: full app width
    expect(main!.querySelector(':scope > .topbar')).toBeTruthy()
    const content = main!.querySelector(':scope > .content')
    expect(content).toBeTruthy()
    // The page sits DIRECTLY in the scrollable content area: no centered
    // max-width wrapper between them (that wrapper is what made MELO feel
    // like a web card on large displays).
    await waitFor(() => {
      const page = content!.querySelector('.page')
      expect(page).toBeTruthy()
      expect(page!.parentElement).toBe(content)
    })
  })

  it('search, library and settings pages all render directly in the content area', async () => {
    const { container } = render(<App />)
    const user = userEvent.setup()
    const content = () => container.querySelector('.main > .content')!

    await waitFor(() => expect(content().querySelector('.page')).toBeTruthy())
    expect(content().querySelector('.page')!.parentElement).toBe(content())

    await user.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(useUIStore.getState().route.name).toBe('search'))
    await waitFor(() => expect(content().querySelector('.page')).toBeTruthy())
    expect(content().querySelector('.page')!.parentElement).toBe(content())

    await user.click(screen.getByRole('button', { name: 'Your Library' }))
    await waitFor(() => expect(useUIStore.getState().route.name).toBe('library'))
    await waitFor(() => expect(content().querySelector('.page')).toBeTruthy())
    expect(content().querySelector('.page')!.parentElement).toBe(content())
  })

  it('the queue panel and expanded Now Playing overlay the main area, with the sidebar still navigable', async () => {
    const { container } = render(<App />)
    const main = () => container.querySelector('.app > .main')!

    // Start playback directly through the global controller (the search
    // journey is covered by app.test.tsx; this test is about structure).
    const { playback } = await import('../state/playback')
    await playback.play(song('a'))
    await waitFor(() => expect(usePlayerStore.getState().current).toBeTruthy())

    // Queue overlay lives inside .main (over the content, beside nothing).
    useUIStore.setState({ queueOpen: true })
    await waitFor(() => expect(main().querySelector(':scope > .panel')).toBeTruthy())

    // Expanded Now Playing overlays .main too — and the sidebar stays
    // outside it, so navigation keeps working while it is open.
    useUIStore.setState({ nowPlayingOpen: true })
    await waitFor(() => expect(main().querySelector(':scope > .now-playing')).toBeTruthy())
    const sidebar = container.querySelector('.app > .sidebar')!
    expect(sidebar).toBeTruthy()
    // The expanded player never swallows the shell: sidebar links still navigate.
    const libraryLink = [...sidebar.querySelectorAll('button')].find((b) => b.textContent?.includes('Library'))
    expect(libraryLink).toBeTruthy()
    const user = userEvent.setup()
    await user.click(libraryLink!)
    await waitFor(() => expect(useUIStore.getState().route.name).toBe('library'))
  })
})
