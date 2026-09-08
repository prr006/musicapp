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
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { setBackend, type Backend } from '../bridge/backend'
import type { Track } from '../bridge/types'
import { ACCENTS, defaultSettings } from '../lib/defaults'
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
    expect(rule('.card-grid')).toContain('minmax(clamp(160px, 11vw, 208px), 1fr)')
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
  it('>=1200px is a two-column composition: artwork cell + metadata/controls cell', () => {
    // The body grid places the artwork cell in one column and the info
    // column in the other — not one centred stack.
    const body = rule('.np-body.solo')
    expect(body).toContain('grid-template-areas: "art info"')
    expect(body).toContain('minmax(300px, min(48%, 680px))') // artwork track ~half the width
    expect(body).toContain('minmax(0, 1fr)') // metadata + controls take the rest
    expect(rule('.np-art-col')).toContain('grid-area: art')
    expect(rule('.np-info-col')).toContain('grid-area: info')
  })

  it('the artwork is height-bounded so it stays fully visible (never cropped)', () => {
    const art = rule('.np-art')
    expect(art).toContain('min(100%, calc(100vh - 260px))')
    // With lyrics open the info column stacks UNDER the art, so the vertical
    // budget is smaller — a separate, tighter bound exists for that mode.
    expect(css).toContain('.np-body.with-lyrics .np-art {')
  })

  it('the scrubber spans the metadata column — the 780px cap is mini-player only', () => {
    expect(rule('.scrubber-row')).toContain('max-width: 780px')
    const idx = css.indexOf('.now-playing .scrubber-row {')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(css.slice(idx, css.indexOf('}', idx))).toContain('max-width: none')
  })

  it('like/dislike/track menu sit with the metadata; transport and secondary rows below', () => {
    expect(rule('.np-actions')).toContain('display: flex')
    expect(rule('.np-secondary')).toContain('flex-wrap: wrap')
  })

  it('control scale: play/pause 58px base, 62px spacious, 48px compact (scoped to the expanded player)', () => {
    expect(rule('.np-buttons .play-btn')).toContain('width: 58px')
    const spacious = mediaBlock('min-width: 1600px')
    expect(spacious).toContain('width: 62px')
    const compact = mediaBlock('max-width: 1199px')
    expect(compact).toContain('width: 48px')
  })

  it('control scale: prev/next hit areas and icons outrank shuffle/repeat; actions stay modest', () => {
    // Prev/next: 44px hit, 20px icons (46/21 at >=1600).
    expect(css).toContain('.now-playing .transport .icon-btn:nth-child(2)')
    const base = css.slice(css.indexOf('.now-playing .transport .icon-btn:nth-child(2)'), css.indexOf('.np-actions .icon-btn,'))
    expect(base).toContain('width: 44px')
    expect(base).toContain('width: 20px')
    // Shuffle/repeat are visibly secondary: 42px hit, 18px icons.
    expect(base).toContain('width: 42px')
    expect(base).toContain('width: 18px')
    // Like/dislike/more: modest 38px hit areas (40 at >=1600).
    expect(base).not.toContain('background: var(--accent)') // never large filled buttons
    // All sizing is scoped to the expanded player — the shared MiniPlayer
    // components keep their own scale.
    expect(rule('.icon-btn')).toContain('width: 34px')
    expect(rule('.volume')).toContain('width: 132px')
    // The expanded player widens the volume slider.
    expect(css).toContain('.now-playing .volume {')
  })

  it('>=1600px uses the spacious tier', () => {
    const spacious = mediaBlock('min-width: 1600px')
    expect(spacious).toContain('minmax(320px, min(50%, 720px))') // larger artwork track
    expect(spacious).toContain('clamp(30px, 2.1vw, 40px)') // larger title
    // Pages benefit too: roomier cards and detail heroes.
    expect(spacious).toContain('clamp(176px, 10vw, 224px)')
    expect(spacious).toContain('clamp(232px, 13vw, 300px)')
  })

  it('>=1920px uses the large-desktop tier (artwork ceiling ~650px, no element inflation)', () => {
    const large = mediaBlock('min-width: 1920px')
    expect(large).toContain('minmax(340px, min(50%, 720px))') // artwork ceiling
    expect(large).toContain('max-width: 2160px') // the composition stays bounded
    expect(large).toContain('minmax(440px, 26fr)') // lyrics region grows too
  })

  it('900-1199px keeps a compact two-column layout', () => {
    const compact = mediaBlock('max-width: 1199px')
    expect(compact).toContain('minmax(240px, min(46%, 440px))') // smaller artwork track, still two columns
    expect(compact).toContain('width: 48px') // compact play button
  })

  it('<900px collapses to the single-column stacked fallback', () => {
    const narrow = mediaBlock('max-width: 900px')
    expect(narrow).toContain('"art"')
    expect(narrow).toContain('"info"')
    expect(narrow).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(narrow).toContain('.np-lyrics-col') // lyrics hidden in the narrow tier
  })

  it('lyrics own the right column when open (art + info stack beside them)', () => {
    const lyrics = rule('.np-body.with-lyrics')
    expect(lyrics).toContain('"art lyrics"')
    expect(lyrics).toContain('"info lyrics"')
    expect(lyrics).toContain('minmax(340px, 27fr)') // substantial region, not a strip
    expect(rule('.np-lyrics-col')).toContain('grid-area: lyrics')
  })

  it('the queue is a docked layout column — pages reflow, nothing is obscured', () => {
    const main = rule('.main')
    expect(main).toContain('grid-template-columns: minmax(0, 1fr) auto')
    const panel = rule('.panel')
    expect(panel).toContain('grid-column: 2')
    expect(panel).not.toContain('position: absolute') // a real column, not an overlay
    expect(rule('.now-playing')).toContain('grid-column: 1') // player spans the content column only
  })

  it('lyrics keep a readable line length on ultra-wide columns', () => {
    expect(rule('.lyrics-pane')).toContain('max-width: 860px')
  })
})

describe('layout: queue panel overlay', () => {
  it('has a responsive width, not a fixed slab', () => {
    const panel = rule('.panel')
    expect(panel).toContain('width: clamp(320px, 30vw, 420px)')
    expect(panel).not.toContain('width: 372px')
  })

  it('Now Playing overlays only the content column; the queue column stays live beside it', () => {
    const np = rule('.now-playing')
    expect(np).toContain('grid-column: 1')
    expect(np).toContain('grid-row: 1 / -1')
    expect(np).toContain('z-index: 70') // above the page content within its column
  })
})

describe('layout: breakpoints', () => {
  it('uses fluid sizing first and only the intended breakpoints', () => {
    const queries = [...css.matchAll(/@media \(([^)]+)\)/g)].map((m) => m[1])
    expect(queries).toEqual(
      expect.arrayContaining(['min-width: 1600px', 'min-width: 1920px', 'max-width: 1199px', 'max-width: 900px', 'prefers-reduced-motion: reduce']),
    )
    // Guard against hard-coded breakpoint sprawl: exactly these five. The
    // 1200–1599px balanced tier is the no-query base (fluid clamp()/vw
    // sizing) rather than another breakpoint.
    expect(queries).toHaveLength(5)
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

/* ---------------- expanded Now Playing: rendered composition ---------------- */

describe('layout: rendered Now Playing composition', () => {
  async function openNowPlaying(opts: { lyrics?: boolean; queue?: boolean } = {}) {
    const { container } = render(<App />)
    const { playback } = await import('../state/playback')
    await playback.play(song('a'))
    await waitFor(() => expect(usePlayerStore.getState().current).toBeTruthy())
    useUIStore.setState({
      nowPlayingOpen: true,
      lyricsOpen: !!opts.lyrics,
      queueOpen: !!opts.queue,
    })
    const section = () => container.querySelector('.main > .now-playing')!
    await waitFor(() => expect(section()).toBeTruthy())
    return { container, section }
  }

  it('renders the two-column composition: artwork cell beside the info cell', async () => {
    const { section } = await openNowPlaying()
    const body = section().querySelector('.np-body')
    expect(body).toBeTruthy()
    expect(body!.classList.contains('solo')).toBe(true)
    // Two named grid cells — artwork and metadata/controls — not one stack.
    const artCol = body!.querySelector(':scope > .np-art-col')
    const infoCol = body!.querySelector(':scope > .np-info-col')
    expect(artCol).toBeTruthy()
    expect(infoCol).toBeTruthy()
    expect(artCol!.querySelector('.np-art')).toBeTruthy()
    // The info column carries the full right-side stack: metadata, actions
    // (like / dislike / track menu), progress, transport, secondary row.
    expect(infoCol!.querySelector('.np-title')).toBeTruthy()
    expect(infoCol!.querySelector('.np-actions')).toBeTruthy()
    expect(infoCol!.querySelector('.np-controls .scrubber-row')).toBeTruthy()
    expect(infoCol!.querySelectorAll('.np-buttons button').length).toBeGreaterThanOrEqual(4)
    expect(infoCol!.querySelector('.np-secondary [aria-label="Playback speed"]')).toBeTruthy()
    expect(infoCol!.querySelector('.np-secondary [aria-label="Sleep timer"]')).toBeTruthy()
    expect(infoCol!.querySelector('.np-secondary [aria-label="Mute"], .np-secondary [aria-label="Unmute"]')).toBeTruthy()
    // No lyrics column when lyrics are closed.
    expect(body!.querySelector('.np-lyrics-col')).toBeNull()
  })

  it('lyrics open: the lyrics column exists and the art/info cells remain', async () => {
    const { section } = await openNowPlaying({ lyrics: true })
    const body = section().querySelector('.np-body')!
    expect(body.classList.contains('with-lyrics')).toBe(true)
    // The lyrics column exists and hosts the pane (whatever state it is in —
    // synced, plain, loading or empty all live in that column).
    const lyricsCol = body.querySelector(':scope > .np-lyrics-col') as HTMLElement
    expect(lyricsCol).toBeTruthy()
    expect(lyricsCol.childElementCount).toBeGreaterThan(0)
    expect(body.querySelector(':scope > .np-art-col')).toBeTruthy()
    expect(body.querySelector(':scope > .np-info-col')).toBeTruthy()
  })

  it('queue open: the panel docks as a sibling column beside the player', async () => {
    const { container, section } = await openNowPlaying({ queue: true })
    const main = container.querySelector('.app > .main')!
    // The panel is a direct child of the workspace grid, after the player.
    const panel = main.querySelector(':scope > .panel')
    expect(panel).toBeTruthy()
    expect(section().querySelector('.np-body')).toBeTruthy()
    // Both live at once: the player does not swallow the panel.
    expect(panel!.compareDocumentPosition(section()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('the track menu opens from the info column (shared TrackMenu)', async () => {
    const { section } = await openNowPlaying()
    const more = section().querySelector('[aria-label="More options"]') as HTMLElement
    expect(more).toBeTruthy()
    fireEvent.click(more)
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy())
  })

  it('empty player state renders without composition cells', async () => {
    const { container } = render(<App />)
    useUIStore.setState({ nowPlayingOpen: true })
    const section = () => container.querySelector('.main > .now-playing')!
    await waitFor(() => expect(section()).toBeTruthy())
    const body = section().querySelector('.np-body')!
    expect(body.classList.contains('empty')).toBe(true)
    expect(body.querySelector('.state')).toBeTruthy()
  })
})

/* ---------------- visual system integration ---------------- */

describe('visual system integration (cinematic MELO direction)', () => {
  it('restrained teal accent, warm orange reserved for contextual moments', () => {
    const root = rule(':root')
    expect(root).toContain('--accent: #2dd4bf')
    expect(root).toContain('--accent-warm: #ff6a3d')
    expect(root).toContain('--accent-soft')
    // The light theme keeps a readable teal.
    expect(css).toContain('html[data-theme=\'light\']') // presence sanity
  })

  it('the runtime accent system defaults to the teal palette (matches the CSS tokens)', () => {
    // main.tsx overrides --accent at runtime from the setting; the DEFAULT
    // must be the same restrained teal the stylesheet ships with, or the
    // whole system would silently fall back to the old orange.
    expect(defaultSettings().accent).toBe('tide')
    expect(ACCENTS.tide.value).toBe('#2dd4bf')
    expect(ACCENTS.ember.value).toBe('#ff6a3d') // the warm accent stays selectable
  })

  it('typography: Sora-style display face over a Manrope-style UI face, local-safe', () => {
    const root = rule(':root')
    expect(root).toContain("--font-display: 'Sora'")
    expect(root).toContain("--font: 'Manrope'")
    // No font is downloaded: index.html stays free of font links.
    // Headings and brand carry the display face.
    expect(css.match(/font-family: var\(--font-display\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('sidebar covers Home/Search/Library/Artists/Albums/Settings with an active indicator', async () => {
    const { container } = render(<App />)
    const sidebar = container.querySelector('.app > .sidebar') as HTMLElement
    expect(sidebar).toBeTruthy()
    for (const name of ['Home', 'Search', 'Your Library', 'Artists', 'Albums', 'Settings']) {
      expect(within(sidebar).getByRole('button', { name })).toBeTruthy()
    }
    // Artists/Albums navigate the EXISTING library tabs — no duplicate nav state.
    await userEvent.click(within(sidebar).getByRole('button', { name: 'Artists' }))
    await waitFor(() => expect(useUIStore.getState().route).toMatchObject({ name: 'library', tab: 'artists' }))
    await userEvent.click(within(sidebar).getByRole('button', { name: 'Albums' }))
    await waitFor(() => expect(useUIStore.getState().route).toMatchObject({ name: 'library', tab: 'albums' }))
    // The active-state indicator is a styled accent bar.
    expect(css).toContain(".nav-item[aria-current='true']::before")
  })

  it('top bar exposes lyrics and queue shortcuts wired to the real UI state', () => {
    render(<App />)
    const topbar = document.querySelector('.topbar') as HTMLElement
    expect(topbar).toBeTruthy()
    const queueBtn = within(topbar).getByRole('button', { name: 'Queue' })
    fireEvent.click(queueBtn)
    expect(useUIStore.getState().queueOpen).toBe(true)
    fireEvent.click(queueBtn)
    expect(useUIStore.getState().queueOpen).toBe(false)
    const lyricsBtn = within(topbar).getByRole('button', { name: 'Toggle lyrics' })
    fireEvent.click(lyricsBtn)
    expect(useUIStore.getState().lyricsOpen).toBe(true)
    fireEvent.click(lyricsBtn)
    expect(useUIStore.getState().lyricsOpen).toBe(false)
  })

  it('queue sections: uppercase group titles with the warm radio glyph', () => {
    expect(rule('.queue-group-title')).toContain('text-transform: uppercase')
    expect(rule('.radio-glyph')).toContain('var(--accent-warm)')
  })

  it('artist pages carry a wide hero backdrop with a functional scrim', () => {
    expect(css).toContain('.detail-head.artist-hero')
    expect(css).toContain('.hero-backdrop')
    expect(css).toContain('filter: blur(46px)')
  })

  it('home "made for you" tiles use the mix-card treatment (warm contextual accent)', () => {
    expect(rule('.mix-card')).toContain('display: flex')
    expect(rule('.mix-glyph.warm')).toContain('var(--accent-warm)')
  })

  it('selected tabs are accent-tinted; the current row carries an accent edge', () => {
    expect(rule(".chip[aria-selected='true']")).toContain('var(--accent-soft)')
    expect(css).toContain(".track-row[data-current='true'] {")
    expect(css).toContain('inset 2px 0 0 var(--accent)')
  })

  it('expanded player: accent-filled play button and accent progress', () => {
    expect(css).toContain('.np-buttons .play-btn:not(.loading)')
    expect(css).toContain('.now-playing .scrubber .fill')
  })

  it('lyrics: current line accented, passed lines subdued', () => {
    expect(rule('.lyric-line.active')).toContain('var(--accent)')
    expect(rule('.lyric-line.passed')).toContain('opacity: 0.45')
  })
})

/* ---------------- rendered control sizing (real selector cascade) ----------------
   Locks the ACTUAL elements to the sizing rules: for every control we assert
   (a) no inline width/height (the bug class that kept Play/Pause at 40px
   while CSS claimed 58-62px), (b) the exact stylesheet selector matches the
   rendered element, and (c) the cascade winner — computed by specificity and
   order over rules that match the element — is the intended size. This is
   selector matching against the real DOM, not string presence. */

interface CssRule {
  selector: string
  decls: string
  media: string | null
  order: number
}

function parseRules(text: string): CssRule[] {
  const out: CssRule[] = []
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '')
  let order = 0
  const walk = (body: string, media: string | null) => {
    let i = 0
    while (i < body.length) {
      const open = body.indexOf('{', i)
      if (open < 0) break
      const sel = body.slice(i, open).trim()
      // find the matching close brace for this block
      let depth = 1, j = open + 1
      while (j < body.length && depth > 0) {
        if (body[j] === '{') depth += 1
        if (body[j] === '}') depth -= 1
        j += 1
      }
      const inner = body.slice(open + 1, j - 1)
      if (sel.startsWith('@media')) {
        walk(inner, sel.slice(sel.indexOf('('), sel.lastIndexOf(')') + 1))
      } else if (!sel.startsWith('@')) {
        out.push({ selector: sel, decls: inner, media, order: order++ })
      }
      i = j
    }
  }
  walk(src, null)
  return out
}

const parsedRules = parseRules(css)

/** (ids, classes/pseudo-classes, types) — enough for this stylesheet (no ids). */
function specificity(sel: string): [number, number, number] {
  let a = 0, b = 0, c = 0
  for (const token of sel.split(/\s*[ >+~]\s*/)) {
    if (!token || token === '*') continue
    a += (token.match(/#[\w-]+/g) ?? []).length
    b += (token.match(/[.][\w-]+/g) ?? []).length + (token.match(/:{1,2}[\w-]+/g) ?? []).length
    const tags = token.replace(/[#.][\w-]+|:{1,2}[\w-]+(\([^)]*\))?/g, '').trim()
    if (tags) c += 1
  }
  return [a, b, c]
}

/** Winning declaration for `prop` among rules that match `el` (inline style wins all). */
function winning(el: Element, prop: string, applicable: (media: string | null) => boolean): string {
  const inline = (el as HTMLElement).style.getPropertyValue(prop)
  if (inline) return `inline:${inline}`
  let best: CssRule | null = null
  let bestSpec: [number, number, number] = [-1, -1, -1]
  for (const rule of parsedRules) {
    if (!applicable(rule.media)) continue
    if (!rule.decls.includes(`${prop}:`)) continue
    for (const single of rule.selector.split(',')) {
      const sel = single.trim()
      if (!sel) continue
      try {
        if (!el.matches(sel)) continue
      } catch {
        continue
      }
      const spec = specificity(sel)
      if (
        spec[0] > bestSpec[0] ||
        (spec[0] === bestSpec[0] && spec[1] > bestSpec[1]) ||
        (spec[0] === bestSpec[0] && spec[1] === bestSpec[1] && (spec[2] > bestSpec[2] || (spec[2] === bestSpec[2] && rule.order > (best?.order ?? -1))))
      ) {
        best = { ...rule, selector: sel }
        bestSpec = spec
      }
    }
  }
  if (!best) return 'none'
  const m = new RegExp(`${prop}:\\s*([^;]+)`).exec(best.decls)
  return m ? m[1].trim() : 'none'
}

const BASE = (media: string | null) => media === null
const SPACIOUS = (media: string | null) => media === null || media === '(min-width: 1600px)'
const COMPACT = (media: string | null) => media === null || media === '(max-width: 1199px)'

describe('rendered control sizing (real selector cascade)', () => {
  it('the actual play/pause element receives the intended sizes at every tier', async () => {
    const { container } = render(<App />)
    const { playback } = await import('../state/playback')
    await playback.play(song('a'))
    useUIStore.setState({ nowPlayingOpen: true })
    const np = () => container.querySelector('.main > .now-playing')!
    await waitFor(() => expect(np()).toBeTruthy())

    const play = np().querySelector('.np-buttons .play-btn') as HTMLElement
    expect(play).toBeTruthy()
    // The bug class: an inline size would override every stylesheet rule.
    expect(play.getAttribute('style') ?? '').not.toMatch(/width|height/)
    // The .now-playing ancestor really wraps it (scoped selectors apply).
    expect(play.closest('.now-playing')).toBeTruthy()
    // The exact stylesheet selector matches the rendered element.
    expect(play.matches('.np-buttons .play-btn')).toBe(true)
    // Cascade winners by tier.
    expect(winning(play, 'width', BASE)).toBe('58px')
    expect(winning(play, 'width', SPACIOUS)).toBe('62px')
    expect(winning(play, 'width', COMPACT)).toBe('48px')
    expect(winning(play.querySelector('svg')!, 'width', BASE)).toBe('26px')
  })

  it('previous/next: 44px hit areas at 1200-1599, 46px at >=1600 — on the real elements', async () => {
    const { container } = render(<App />)
    const { playback } = await import('../state/playback')
    await playback.play(song('a'))
    useUIStore.setState({ nowPlayingOpen: true })
    const np = () => container.querySelector('.main > .now-playing')!
    await waitFor(() => expect(np()).toBeTruthy())

    const prev = np().querySelector('.transport [aria-label="Previous"]') as HTMLElement
    const next = np().querySelector('.transport [aria-label="Next"]') as HTMLElement
    expect(prev).toBeTruthy()
    expect(next).toBeTruthy()
    // The structural selectors the CSS relies on genuinely match these nodes.
    expect(prev.matches('.now-playing .transport .icon-btn:nth-child(2)')).toBe(true)
    expect(next.matches('.now-playing .transport .icon-btn:nth-child(4)')).toBe(true)
    expect(prev.getAttribute('style') ?? '').not.toMatch(/width|height/)
    expect(winning(prev, 'width', BASE)).toBe('44px')
    expect(winning(next, 'width', BASE)).toBe('44px')
    expect(winning(prev, 'width', SPACIOUS)).toBe('46px')
    expect(winning(prev.querySelector('svg')!, 'width', BASE)).toBe('20px')
    expect(winning(prev.querySelector('svg')!, 'width', SPACIOUS)).toBe('21px')
  })

  it('shuffle/repeat stay secondary (42px base, 44px spacious) on the real elements', async () => {
    const { container } = render(<App />)
    const { playback } = await import('../state/playback')
    await playback.play(song('a'))
    useUIStore.setState({ nowPlayingOpen: true })
    const np = () => container.querySelector('.main > .now-playing')!
    await waitFor(() => expect(np()).toBeTruthy())

    const shuffle = np().querySelector('.transport [aria-label="Shuffle"]') as HTMLElement
    const repeat = np().querySelector('.transport [aria-label^="Repeat"]') as HTMLElement
    expect(shuffle).toBeTruthy()
    expect(repeat).toBeTruthy()
    expect(shuffle.matches('.now-playing .transport .icon-btn:first-child')).toBe(true)
    expect(repeat.matches('.now-playing .transport .icon-btn:last-child')).toBe(true)
    expect(winning(shuffle, 'width', BASE)).toBe('42px')
    expect(winning(repeat, 'width', BASE)).toBe('42px')
    expect(winning(shuffle, 'width', SPACIOUS)).toBe('44px')
  })

  it('like/dislike/more: modest 38px hit areas via the actions selector', async () => {
    const { container } = render(<App />)
    const { playback } = await import('../state/playback')
    await playback.play(song('a'))
    useUIStore.setState({ nowPlayingOpen: true })
    const np = () => container.querySelector('.main > .now-playing')!
    await waitFor(() => expect(np()).toBeTruthy())

    const actions = np().querySelectorAll('.np-actions .icon-btn')
    expect(actions.length).toBe(3) // like, dislike, more
    for (const btn of actions) {
      expect(btn.matches('.now-playing .np-actions .icon-btn')).toBe(true)
      expect(winning(btn, 'width', BASE)).toBe('38px')
      expect(winning(btn, 'width', SPACIOUS)).toBe('40px')
    }
  })

  it('the MiniPlayer play button is untouched: 40px, and the expanded-player selector does NOT match it', async () => {
    const { container } = render(<App />)
    const { playback } = await import('../state/playback')
    await playback.play(song('a'))
    const mini = container.querySelector('.player-bar .play-btn') as HTMLElement
    expect(mini).toBeTruthy()
    expect(mini.closest('.now-playing')).toBeNull()
    expect(mini.matches('.np-buttons .play-btn')).toBe(false) // scoped rule cannot leak
    expect(mini.getAttribute('style') ?? '').not.toMatch(/width|height/) // sized by CSS, not inline
    expect(winning(mini, 'width', BASE)).toBe('40px')
  })
})
