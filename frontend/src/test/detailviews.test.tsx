/**
 * Polished Artist + Album experience tests: page structure and metadata,
 * honest handling of missing metadata, canonical identity across video
 * versions, action semantics through the GLOBAL queue/radio systems, and
 * navigation rules (uploader/channel never becomes an artist page).
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Backend } from '../bridge/backend'
import { setBackend } from '../bridge/backend'
import type { PlayRecord, Track } from '../bridge/types'
import { defaultSettings } from '../lib/defaults'
import { albumKey, appearsOnAlbums, popularTracks } from '../lib/derive'
import { useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { usePlayerStore } from '../state/playerStore'
import { useUIStore } from '../state/uiStore'
import { AlbumView, ArtistView } from '../views/DetailViews'

function song(id: string, extra: Partial<Track> = {}): Track {
  return {
    id: `yt:${id}`, sourceId: id, source: 'youtube', url: '', title: `Song ${id}`,
    artist: 'Halcyon', album: 'Blue Hours', artwork: `http://img/${id}.jpg`,
    duration: 200, explicit: false, ...extra,
  }
}

function stubBackend(): { relatedFor: (t: Track) => Track[] } {
  const feed = Array.from({ length: 6 }, (_, i) =>
    song(`rel${i}`, { title: `Related ${i}`, artist: `Related Artist ${i}`, album: '' }),
  )
  const be = {
    isNative: false,
    search: vi.fn(async () => ({ query: '', songs: [], videos: [], albums: [], artists: [], provider: 'test' })),
    relatedTracks: vi.fn(async () => ({ tracks: feed, source: 'ytmusic-next' })),
    logRadio: vi.fn(async () => {}),
    getPlayable: vi.fn(async (t: Track) => ({
      trackId: t.id, url: `http://local/${t.sourceId}`, mimeType: 'audio/mp4', duration: 200, bitrate: 128, expiresAt: 0,
    })),
    getLyrics: vi.fn(async () => ({ trackId: '', source: 't', synced: false, lines: [], plain: '', instrumental: false, offset: 0, matchedTitle: '', matchedArtist: '' })),
    saveSettings: vi.fn(async (s) => s),
    setLiked: vi.fn(async () => []),
    recordPlay: vi.fn(async (t: Track) => [{ track: t, playedAt: Date.now() }] as PlayRecord[]),
    recordPlayEvent: vi.fn(async (t: Track) => {
      const s = useLibraryStore.getState()
      return { history: [{ track: t, playedAt: Date.now() }, ...s.history], stats: s.stats, disliked: s.disliked }
    }),
    setDisliked: vi.fn(async () => ({ history: [], stats: {}, disliked: [] })),
    clearHistory: vi.fn(async () => {}),
    addSearchTerm: vi.fn(async () => []), removeSearchTerm: vi.fn(async () => []),
    clearSearchHistory: vi.fn(async () => {}), libraryTracks: vi.fn(async () => []),
    saveSession: vi.fn(async () => {}), clearSession: vi.fn(async () => {}),
    createPlaylist: vi.fn(), renamePlaylist: vi.fn(), deletePlaylist: vi.fn(),
    addTracksToPlaylist: vi.fn(), removeTrackFromPlaylist: vi.fn(), reorderPlaylist: vi.fn(),
    duplicatePlaylist: vi.fn(), installResolver: vi.fn(), setNowPlaying: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
    getState: vi.fn(async () => ({ settings: defaultSettings(), liked: [], playlists: [], history: [], searchHistory: [], session: null, version: 1 })),
    getDiagnostics: vi.fn(async () => ({})),
  } as unknown as Backend
  setBackend(be)
  return { relatedFor: () => feed }
}

const state = () => usePlayerStore.getState()
const blueHours = ['one', 'two', 'three'].map((n, i) =>
  song(n, { title: `Blue ${n.charAt(0).toUpperCase() + n.slice(1)}`, duration: 240 - i * 30 }),
)
const dc = song('dc1', { title: 'DC Theme', artist: 'Anirudh Ravichander', album: 'DC (Original Motion Picture Soundtrack)' })

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
  useUIStore.setState({ route: { name: 'home' }, history: [], future: [], queueOpen: false, nowPlayingOpen: false, lyricsOpen: false, toasts: [], resolverError: null, resolverProgress: null })
})

afterEach(() => {
  playback.stop()
  cleanup()
  vi.clearAllMocks()
})

describe('album page', () => {
  const key = albumKey(blueHours[0])

  it('renders album metadata: kind, title, artist, song count, total duration', () => {
    useLibraryStore.setState({ liked: blueHours })
    render(<AlbumView albumKey={key} />)
    const head = document.querySelector('.detail-meta') as HTMLElement
    expect(within(head).getByText('Album', { exact: true }).className).toContain('kind')
    expect(within(head).getByText('Blue Hours')).toBeInTheDocument()
    expect(within(head).getByText('Halcyon')).toBeInTheDocument()
    expect(within(head).getByText('3 songs')).toBeInTheDocument()
    // 240 + 210 + 180 = 630s → Math.round(10.5 min) = "11 min".
    expect(within(head).getByText('11 min')).toBeInTheDocument()
  })

  it('handles missing metadata safely: no durations, no artist link, still renders', () => {
    const bare = song('bare', { title: 'Bare', artist: 'Someone', album: 'No Durations', duration: 0 })
    useLibraryStore.setState({ liked: [bare] })
    render(<AlbumView albumKey={albumKey(bare)} />)
    expect(screen.getByText('No Durations')).toBeInTheDocument()
    expect(screen.getByText('1 song')).toBeInTheDocument()
    expect(screen.queryByText(/min|hr/)).not.toBeInTheDocument() // no fabricated duration
    // An album whose tracks have no artist at all shows a muted placeholder,
    // never a link to a bogus artist page.
    const noArtist = song('na', { title: 'NA', artist: '', album: 'No Artist LP' })
    useLibraryStore.setState({ liked: [noArtist] })
    cleanup()
    render(<AlbumView albumKey={albumKey(noArtist)} />)
    const head2 = document.querySelector('.detail-meta') as HTMLElement
    expect(within(head2).getByText('Unknown artist')).toBeInTheDocument()
    expect(within(head2).queryByRole('button', { name: 'Unknown artist' })).not.toBeInTheDocument()
  })

  it('renders the track list in library (encounter) order with track numbers', () => {
    useLibraryStore.setState({ liked: blueHours })
    render(<AlbumView albumKey={key} />)
    const rows = document.querySelectorAll('.track-list .track-row')
    expect(rows).toHaveLength(3)
    expect(within(rows[0] as HTMLElement).getByText('Blue One')).toBeInTheDocument()
    expect(within(rows[2] as HTMLElement).getByText('Blue Three')).toBeInTheDocument()
  })

  it('Play uses the global user queue from track 1 and never mixes into autoplay', async () => {
    useLibraryStore.setState({ liked: blueHours })
    render(<AlbumView albumKey={key} />)
    await userEvent.click(screen.getByRole('button', { name: /^Play$/i }))
    await waitFor(() => expect(state().current?.id).toBe('yt:one'))
    expect(state().queue.map((t) => t.id)).toEqual(['yt:one', 'yt:two', 'yt:three'])
    expect(state().playingFrom).toBe('queue')
    expect(state().contextLabel).toBe('Blue Hours')
  })

  it('Shuffle plays the album shuffled through the global queue', async () => {
    useLibraryStore.setState({ liked: blueHours })
    render(<AlbumView albumKey={key} />)
    await userEvent.click(screen.getByRole('button', { name: /Shuffle/i }))
    await waitFor(() => expect(state().status).toBe('playing'))
    expect(state().shuffle).toBe(true)
    expect(state().queue).toHaveLength(3)
    expect(state().queue.map((t) => t.id).sort()).toEqual(['yt:one', 'yt:three', 'yt:two'])
    expect(state().playingFrom).toBe('queue')
  })

  it('Add to queue APPENDS to the existing user queue without replacing it', async () => {
    useLibraryStore.setState({ liked: [dc, ...blueHours] })
    render(<AlbumView albumKey={albumKey(dc)} />)
    await userEvent.click(screen.getByRole('button', { name: /Play DC Theme/i }))
    await waitFor(() => expect(state().current?.id).toBe('yt:dc1'))
    cleanup()
    render(<AlbumView albumKey={key} />)
    const actions = document.querySelector('.detail-actions') as HTMLElement
    await userEvent.click(within(actions).getByRole('button', { name: /Add to queue/i }))
    await waitFor(() => expect(state().queue.map((t) => t.id)).toEqual(['yt:dc1', 'yt:one', 'yt:two', 'yt:three']))
    expect(state().current?.id).toBe('yt:dc1') // playback untouched
  })

  it('Radio starts ALBUM radio: the album seed is queued alone and the radio builds separately', async () => {
    useLibraryStore.setState({ liked: blueHours })
    render(<AlbumView albumKey={key} />)
    await userEvent.click(screen.getByRole('button', { name: /Radio/i }))
    await waitFor(() => expect(state().current?.id).toBe('yt:one'))
    expect(state().queue.map((t) => t.id)).toEqual(['yt:one']) // never the siblings
    // The radio builds through the provider — album-context profile.
    await waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
  })

  it('album rows reuse the shared track actions (queue + start radio via the global menu)', async () => {
    useLibraryStore.setState({ liked: blueHours })
    render(<AlbumView albumKey={key} />)
    await userEvent.click(screen.getByRole('button', { name: /Play Blue One/i }))
    await waitFor(() => expect(state().current?.id).toBe('yt:one'))
    const rows = document.querySelectorAll('.track-list .track-row')
    await userEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Add to queue' }))
    await waitFor(() => expect(state().queue).toHaveLength(3))
    await userEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Start radio/i }))
    await waitFor(() => expect(state().queue.map((t) => t.id)).toEqual(['yt:two']))
    await waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
  })

  it('different video versions of one song create ONE album row (canonical identity)', () => {
    const official = song('v1', { title: 'Blue One', album: 'Blue Hours' })
    const video = song('v2', { title: 'Blue One (Official Video)', album: 'Blue Hours' })
    useLibraryStore.setState({ liked: [official, video, blueHours[1], blueHours[2]] })
    render(<AlbumView albumKey={key} />)
    const rows = document.querySelectorAll('.track-list .track-row')
    expect(rows).toHaveLength(3) // not 4: the duplicate upload collapsed
    const head = document.querySelector('.detail-meta') as HTMLElement
    expect(within(head).getByText('3 songs')).toBeInTheDocument()
  })
})

describe('artist page', () => {
  it('renders real artist metadata and facts', () => {
    useLibraryStore.setState({ liked: blueHours })
    render(<ArtistView name="Halcyon" />)
    const head = document.querySelector('.detail-meta') as HTMLElement
    expect(within(head).getByText('Artist', { exact: true }).className).toContain('kind')
    expect(within(head).getByText('Halcyon')).toBeInTheDocument()
    expect(within(head).getByText('3 songs')).toBeInTheDocument()
  })

  it('an uploader/channel-only track NEVER creates an artist page', () => {
    useLibraryStore.setState({
      liked: [song('u1', { artist: '', uploader: 'The Naghera', album: '' })],
    })
    render(<ArtistView name="The Naghera" />)
    expect(screen.getByText(/Nothing saved for The Naghera/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Play$/i })).not.toBeInTheDocument()
  })

  it('Artist Radio stays artist-centered: the artist seed queues alone and radio builds', async () => {
    useLibraryStore.setState({ liked: blueHours })
    render(<ArtistView name="Halcyon" />)
    await userEvent.click(screen.getByRole('button', { name: /Radio/i }))
    await waitFor(() => expect(state().current?.id).toBe(blueHours[0].id))
    expect(state().queue.map((t) => t.id)).toEqual([blueHours[0].id])
    await waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
  })

  it('Popular renders from persisted play counts and is omitted without stats', () => {
    useLibraryStore.setState({
      liked: blueHours,
      stats: {
        'yt:two': { playCount: 9, significantCount: 0, completeCount: 0, skipCount: 0, lastPlayedAt: 5 },
        'yt:one': { playCount: 4, significantCount: 0, completeCount: 0, skipCount: 0, lastPlayedAt: 1 },
      },
    })
    render(<ArtistView name="Halcyon" />)
    expect(screen.getByText('Popular')).toBeInTheDocument()
    const popular = screen.getByText('Popular').closest('section') as HTMLElement
    const rows = popular.querySelectorAll('.track-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('Blue Two')).toBeInTheDocument() // 9 plays first
    // No stats at all -> no Popular section at all (nothing fabricated).
    useLibraryStore.setState({ stats: {} })
    cleanup()
    render(<ArtistView name="Halcyon" />)
    expect(screen.queryByText('Popular')).not.toBeInTheDocument()
  })

  it('Albums section renders and navigates to the album page', async () => {
    useLibraryStore.setState({ liked: blueHours })
    const { store } = { store: useUIStore.getState() }
    render(<ArtistView name="Halcyon" />)
    await userEvent.click(screen.getByRole('button', { name: /Open Blue Hours/i }))
    expect(useUIStore.getState().route).toEqual({ name: 'album', key: albumKey(blueHours[0]) })
    void store
  })

  it('Appears On lists only albums where the artist is a FEATURED artist', () => {
    const feature = song('feat', {
      title: 'Collab', artist: 'Other Band, Halcyon', album: 'Other Band LP',
    })
    useLibraryStore.setState({ liked: [...blueHours, feature] })
    render(<ArtistView name="Halcyon" />)
    expect(screen.getByText('Appears on')).toBeInTheDocument()
    const section = screen.getByText('Appears on').closest('section') as HTMLElement
    expect(within(section).getByText('Other Band LP')).toBeInTheDocument()
    // The artist's own album is not repeated in Appears On.
    expect(within(section).queryByText('Blue Hours')).not.toBeInTheDocument()
    // Without feature credits the section disappears entirely.
    useLibraryStore.setState({ liked: blueHours })
    cleanup()
    render(<ArtistView name="Halcyon" />)
    expect(screen.queryByText('Appears on')).not.toBeInTheDocument()
  })

  it('missing sections never break the page: artist with one loose song, no albums', () => {
    useLibraryStore.setState({ liked: [song('loose', { album: '' })] })
    render(<ArtistView name="Halcyon" />)
    expect(screen.getByText('Songs')).toBeInTheDocument()
    expect(screen.queryByText('Albums')).not.toBeInTheDocument()
    expect(screen.queryByText('Popular')).not.toBeInTheDocument()
  })
})

describe('identity + derivation helpers', () => {
  it('popularTracks sorts deterministically (plays, recency, title) and drops zero-play tracks', () => {
    const a = song('a'), b = song('b'), c = song('c')
    const stats = {
      'yt:a': { playCount: 2, significantCount: 0, completeCount: 0, skipCount: 0, lastPlayedAt: 50 },
      'yt:b': { playCount: 9, significantCount: 0, completeCount: 0, skipCount: 0, lastPlayedAt: 10 },
      'yt:c': { playCount: 2, significantCount: 0, completeCount: 0, skipCount: 0, lastPlayedAt: 60 },
    }
    expect(popularTracks([a, b, c], stats).map((t) => t.id)).toEqual(['yt:b', 'yt:c', 'yt:a'])
    expect(popularTracks([a, c], {})).toHaveLength(0)
  })

  it('appearsOnAlbums uses only real feature credits', () => {
    const tracks = [
      song('x', { title: 'X', artist: 'Halcyon', album: 'Blue Hours' }),
      song('y', { title: 'Y', artist: 'Other Band, Halcyon', album: 'Other LP' }),
      song('z', { title: 'Z', artist: 'Other Band', album: 'Other LP' }),
    ]
    const albums = appearsOnAlbums('halcyon', tracks)
    expect(albums.map((a) => a.title)).toEqual(['Other LP']) // own album excluded, plain Other Band track has no Halcyon credit
  })

  it('provider album cards navigate with the library album key (no dead browse ids)', () => {
    // The exact formula SearchView now uses must match findAlbum's key.
    const providerAlbum = { id: 'MPREb_9999', title: 'Blue Hours', artist: 'Halcyon', year: '2021', artwork: '' }
    const key = albumKey({ album: providerAlbum.title, artist: providerAlbum.artist })
    expect(key).toBe(albumKey(blueHours[0]))
  })
})
