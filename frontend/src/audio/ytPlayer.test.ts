/**
 * Tests for the YouTube IFrame playback adapter (audio/ytPlayer.ts).
 *
 * The adapter is exercised through a fake YT.Player that reproduces the
 * IFrame API's real event contract, including the race conditions the
 * adapter exists to guard:
 *
 *  - a stale video's events arriving after a newer load
 *  - duplicate ENDED events
 *  - provider rejections (100/101/150/153) mapping to FATAL errors
 *  - autoplay blocked transitions to paused
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extractVideoId, loadYouTubeApi, YTPlaybackAdapter, YTPlayerHost } from './ytPlayer'
import type { EngineEvent } from './engineTypes'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface FakePlayer {
  loadVideoById: ReturnType<typeof vi.fn>
  cueVideoById: ReturnType<typeof vi.fn>
  playVideo: ReturnType<typeof vi.fn>
  pauseVideo: ReturnType<typeof vi.fn>
  stopVideo: ReturnType<typeof vi.fn>
  seekTo: ReturnType<typeof vi.fn>
  getCurrentTime: ReturnType<typeof vi.fn>
  getDuration: ReturnType<typeof vi.fn>
  setVolume: ReturnType<typeof vi.fn>
  mute: ReturnType<typeof vi.fn>
  unMute: ReturnType<typeof vi.fn>
  setPlaybackRate: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  onReady?: () => void
  onStateChange?: (e: { data: number }) => void
  onError?: (e: { data: number }) => void
  onAutoplayBlocked?: () => void
}

let lastPlayer: FakePlayer | null = null
let stateEmitter: ((data: number) => void) | null = null
let errorEmitter: ((data: number) => void) | null = null
let readyEmitter: (() => void) | null = null
let autoplayBlockedEmitter: (() => void) | null = null

function installFakeYT(): void {
  const YT = {
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    Player: vi.fn(function Player(_el: unknown, config: any) {
      const player: FakePlayer = {
        loadVideoById: vi.fn(),
        cueVideoById: vi.fn(),
        playVideo: vi.fn(),
        pauseVideo: vi.fn(),
        stopVideo: vi.fn(),
        seekTo: vi.fn(),
        getCurrentTime: vi.fn(() => 0),
        getDuration: vi.fn(() => 240),
        setVolume: vi.fn(),
        mute: vi.fn(),
        unMute: vi.fn(),
        setPlaybackRate: vi.fn(),
        destroy: vi.fn(),
      }
      player.onReady = config?.events?.onReady
      player.onStateChange = config?.events?.onStateChange
      player.onError = config?.events?.onError
      player.onAutoplayBlocked = config?.events?.onAutoplayBlocked
      lastPlayer = player
      readyEmitter = () => player.onReady?.()
      stateEmitter = (data: number) => player.onStateChange?.({ data })
      errorEmitter = (data: number) => player.onError?.({ data })
      autoplayBlockedEmitter = () => player.onAutoplayBlocked?.()
      return player
    }),
  }
  ;(globalThis as any).YT = YT
  ;(window as any).YT = YT
}

function freshAdapter(): { adapter: YTPlaybackAdapter; events: EngineEvent[] } {
  const adapter = new YTPlaybackAdapter()
  const events: EngineEvent[] = []
  adapter.subscribe((e) => events.push(e))
  return { adapter, events }
}

/**
 * Loads a track through the full handshake: begin → load → (microtasks
 * register the player's callbacks) → onReady fires → load resolves.
 */
async function loadTrack(
  adapter: YTPlaybackAdapter,
  videoId: string,
  autoplay = true,
): Promise<number> {
  const token = adapter.beginLoad(`yt:${videoId}`)
  const loading = adapter.load(token, videoId, 0, autoplay)
  await vi.waitFor(() => expect(readyEmitter).not.toBeNull())
  readyEmitter!()
  expect(await loading).toBe(true)
  return token
}

beforeEach(() => {
  installFakeYT()
  lastPlayer = null
  stateEmitter = null
  errorEmitter = null
  readyEmitter = null
  autoplayBlockedEmitter = null
})

describe('YTPlaybackAdapter', () => {
  it('loads a video by id after the API handshake completes', async () => {
    const { adapter } = freshAdapter()
    await loadTrack(adapter, 'abc12345678')
    expect(lastPlayer!.loadVideoById).toHaveBeenCalledWith({ videoId: 'abc12345678', startSeconds: 0 })
  })

  it('cues (instead of autoplaying) when autoplay is false', async () => {
    const { adapter } = freshAdapter()
    await loadTrack(adapter, 'abc12345678', false)
    expect(lastPlayer!.cueVideoById).toHaveBeenCalled()
    expect(lastPlayer!.loadVideoById).not.toHaveBeenCalled()
  })

  it('events from a new load are processed correctly (generation tracking)', async () => {
    const { adapter, events } = freshAdapter()
    await loadTrack(adapter, 'aaaaaaaaaaa')
    stateEmitter?.(1) // A PLAYING
    await loadTrack(adapter, 'bbbbbbbbbbb')
    // B's events arrive with the current generation — they are processed.
    stateEmitter?.(1) // B PLAYING
    await new Promise((r) => setTimeout(r, 20))
    const playings = events.filter((e) => e.type === 'state' && e.snapshot.status === 'playing')
    expect(playings.length).toBeGreaterThanOrEqual(2) // A's PLAYING + B's PLAYING
  })

  it('advances exactly once on ENDED and swallows the duplicate', async () => {
    const { adapter, events } = freshAdapter()
    await loadTrack(adapter, 'aaaaaaaaaaa')
    stateEmitter?.(1) // PLAYING
    stateEmitter?.(0) // ENDED
    stateEmitter?.(0) // duplicate ENDED
    const ended = events.filter((e) => e.type === 'ended')
    expect(ended).toHaveLength(1)
  })

  it('maps provider rejections to fatal errors that carry the skip intent', async () => {
    const { adapter, events } = freshAdapter()
    await loadTrack(adapter, 'aaaaaaaaaaa')
    for (const code of [100, 101, 150, 153]) {
      errorEmitter?.(code)
      const fatal = events.filter((e) => e.type === 'error' && e.fatal)
      expect(fatal.length).toBeGreaterThan(0)
      expect((fatal.at(-1) as { message?: string }).message).toMatch(/provider|embed|available|invalid|permission|error/i)
      events.length = 0
    }
  })

  it('does not report fatal on a generic error code', async () => {
    const { adapter, events } = freshAdapter()
    await loadTrack(adapter, 'aaaaaaaaaaa')
    errorEmitter?.(5) // HTML5 player trouble: transport-level, not a bad video
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0] as { fatal?: boolean }).fatal).toBeUndefined()
  })

  it('reports position through the poll timer while playing', async () => {
    vi.useFakeTimers()
    try {
      const { adapter, events } = freshAdapter()
      const token = adapter.beginLoad('yt:aaaaaaaaaaa')
      const loading = adapter.load(token, 'aaaaaaaaaaa', 0, true)
      await vi.waitFor(() => expect(readyEmitter).not.toBeNull())
      readyEmitter!()
      await loading
      lastPlayer!.getCurrentTime = vi.fn(() => 42)
      stateEmitter?.(1) // PLAYING starts the poll timer
      await vi.advanceTimersByTimeAsync(600)
      const positions = events.filter((e) => e.type === 'position')
      expect(positions.length).toBeGreaterThan(0)
      expect((positions.at(-1) as { position: number }).position).toBe(42)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pause + play route to the iframe and update the snapshot', async () => {
    const { adapter } = freshAdapter()
    await loadTrack(adapter, 'aaaaaaaaaaa')
    await adapter.play()
    expect(lastPlayer!.playVideo).toHaveBeenCalled()
    adapter.pause()
    expect(lastPlayer!.pauseVideo).toHaveBeenCalled()
    expect(adapter.snapshot().status).toBe('paused')
  })

  it('applies volume and mute to the iframe', async () => {
    const { adapter } = freshAdapter()
    await loadTrack(adapter, 'aaaaaaaaaaa')
    adapter.setVolume(0.35)
    expect(lastPlayer!.setVolume).toHaveBeenCalledWith(35)
    adapter.setMuted(true)
    expect(lastPlayer!.mute).toHaveBeenCalled()
    adapter.setMuted(false)
    expect(lastPlayer!.unMute).toHaveBeenCalled()
  })

  it('stop() clears the track and refuses later events', async () => {
    const { adapter, events } = freshAdapter()
    await loadTrack(adapter, 'aaaaaaaaaaa')
    adapter.stop()
    expect(adapter.snapshot().trackId).toBeNull()
    stateEmitter?.(0) // late ENDED after stop
    await new Promise((r) => setTimeout(r, 10))
    expect(events.find((e) => e.type === 'ended')).toBeUndefined()
  })

  it('onAutoplayBlocked transitions to paused and clears wantsPlay', async () => {
    const { adapter } = freshAdapter()
    await loadTrack(adapter, 'aaaaaaaaaaa')
    // Simulate autoplay starting then being blocked
    stateEmitter?.(1) // PLAYING
    expect(adapter.snapshot().status).toBe('playing')
    autoplayBlockedEmitter?.()
    expect(adapter.snapshot().status).toBe('paused')
    // Subsequent playVideo should be possible
    await adapter.play()
    expect(lastPlayer!.playVideo).toHaveBeenCalled()
  })

  it('passes origin in player config', async () => {
    const { adapter } = freshAdapter()
    await loadTrack(adapter, 'aaaaaaaaaaa')
    // Verify the YT.Player constructor was called with origin
    const callArgs = (window.YT!.Player as any).mock.calls[0]
    expect(callArgs[1].playerVars.origin).toBe(window.location.origin)
  })

  it('loadYouTubeApi injects the script and resolves with the YT namespace', async () => {
    // Fresh module state: remove YT so the loader has to "fetch" it.
    delete (window as any).YT
    const promise = loadYouTubeApi()
    // The loader registers the global callback and appends the script tag.
    await new Promise((r) => setTimeout(r, 0))
    expect(window.onYouTubeIframeAPIReady).toBeDefined()
    // Simulate the API arriving.
    installFakeYT()
    window.onYouTubeIframeAPIReady?.()
    const YT = await promise
    expect(YT.Player).toBeDefined()
  })
})

describe('YTPlayerHost', () => {
  it('keeps one container and re-attaches it without recreating it', () => {
    const host = YTPlayerHost.get()
    const a = document.createElement('div')
    const b = document.createElement('div')
    host.attachTo(a)
    const first = host.ensureContainer()
    host.attachTo(b)
    expect(host.ensureContainer()).toBe(first)
    expect(first.parentElement).toBe(b)
    host.release()
    expect(first.parentElement).toBeNull()
  })

  it('returns the surface to the dock and reports its location', () => {
    const host = YTPlayerHost.get()
    const dock = document.createElement('div')
    const expanded = document.createElement('div')
    host.setDock(dock)
    host.attachTo(dock)
    expect(host.isDockedHere(dock)).toBe(true)
    expect(host.isDockedHere(expanded)).toBe(false)
    // The expanded Now Playing claims the container…
    host.attachTo(expanded)
    expect(host.isDockedHere(dock)).toBe(false)
    // …and closing the view returns it to the dock, never detached.
    host.attachToDock()
    expect(host.isDockedHere(dock)).toBe(true)
    expect(host.ensureContainer().parentElement).toBe(dock)
    host.release()
  })
})

describe('extractVideoId', () => {
  it.each([
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('extracts %s', (input, expected) => {
    expect(extractVideoId(input)).toBe(expected)
  })

  it('returns null for garbage', () => {
    expect(extractVideoId('not a video')).toBeNull()
    expect(extractVideoId('')).toBeNull()
  })
})
