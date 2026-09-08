import { BrowserMediaSession } from './mediaSession'
import type { Track } from '../bridge/types'

describe('BrowserMediaSession', () => {
  it('registers supported controls and publishes playback position safely', () => {
    const handlers = new Map<string, MediaSessionActionHandler>()
    const setPositionState = vi.fn()
    const fakeSession = {
      metadata: null,
      playbackState: 'none',
      setActionHandler: vi.fn((action: string, handler: MediaSessionActionHandler) => handlers.set(action, handler)),
      setPositionState,
    }
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: fakeSession })
    const play = vi.fn()
    const seek = vi.fn()
    const session = new BrowserMediaSession({
      play, pause: vi.fn(), next: vi.fn(), previous: vi.fn(), seek,
      position: () => 12, duration: () => 180, rate: () => 1,
    })
    handlers.get('play')?.({ action: 'play' })
    handlers.get('seekto')?.({ action: 'seekto', seekTime: 42 })
    session.setPlaybackState('playing')
    session.updatePosition(true)
    expect(play).toHaveBeenCalledOnce()
    expect(seek).toHaveBeenCalledWith(42)
    expect(fakeSession.playbackState).toBe('playing')
    expect(setPositionState).toHaveBeenCalledWith({ duration: 180, position: 12, playbackRate: 1 })
  })
})
