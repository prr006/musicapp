import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaybackEngine } from '../audio/engine'
import { FakeMedia } from '../test/fakeMedia'

describe('PlaybackEngine', () => {
  let media: FakeMedia
  let engine: PlaybackEngine

  beforeEach(() => {
    media = new FakeMedia()
    engine = new PlaybackEngine(media.asElement())
  })

  it('clears the previous source the moment a new load begins', async () => {
    const first = engine.beginLoad('a')
    await engine.load(first, 'http://local/a')
    expect(media.src).toBe('http://local/a')
    expect(engine.snapshot().status).toBe('playing')

    engine.beginLoad('b')
    // Old audio must be gone before the new source is known.
    expect(media.src).toBe('')
    expect(media.paused).toBe(true)
    expect(engine.snapshot().trackId).toBe('b')
    expect(engine.snapshot().status).toBe('loading')
  })

  it('refuses a stale load token', async () => {
    const staleToken = engine.beginLoad('a')
    const freshToken = engine.beginLoad('b')
    await engine.load(freshToken, 'http://local/b')

    const applied = await engine.load(staleToken, 'http://local/a')
    expect(applied).toBe(false)
    expect(media.src).toBe('http://local/b')
    expect(engine.snapshot().trackId).toBe('b')
  })

  it('reports ended exactly once for the loaded track', async () => {
    const events: string[] = []
    engine.subscribe((e) => {
      if (e.type === 'ended') events.push(e.trackId)
    })
    const token = engine.beginLoad('a')
    await engine.load(token, 'http://local/a')
    media.setDuration(10)
    media.endNaturally()
    expect(events).toEqual(['a'])
  })

  it('does not emit ended after stop()', async () => {
    const ended = vi.fn()
    engine.subscribe((e) => {
      if (e.type === 'ended') ended()
    })
    const token = engine.beginLoad('a')
    await engine.load(token, 'http://local/a')
    engine.stop()
    media.endNaturally()
    expect(ended).not.toHaveBeenCalled()
    expect(engine.snapshot().status).toBe('idle')
    expect(engine.snapshot().trackId).toBeNull()
  })

  it('publishes the media element position, never a synthetic clock', async () => {
    const positions: number[] = []
    engine.subscribe((e) => {
      if (e.type === 'position') positions.push(e.position)
    })
    const token = engine.beginLoad('a')
    await engine.load(token, 'http://local/a')
    media.setDuration(30)
    media.tick(4.5)
    media.tick(9)
    expect(positions).toContain(4.5)
    expect(positions).toContain(9)
    expect(engine.position).toBe(9)
  })

  it('seek clamps to the media duration and republishes position', async () => {
    const token = engine.beginLoad('a')
    await engine.load(token, 'http://local/a')
    media.setDuration(20)
    engine.seek(45)
    expect(media.currentTime).toBe(20)
    engine.seek(-5)
    expect(media.currentTime).toBe(0)
  })

  it('surfaces decode failures as a real error state', async () => {
    const errors: string[] = []
    engine.subscribe((e) => {
      if (e.type === 'error') errors.push(e.message)
    })
    const token = engine.beginLoad('a')
    await engine.load(token, 'http://local/a')
    media.failWith(3) // MEDIA_ERR_DECODE
    expect(engine.snapshot().status).toBe('error')
    expect(errors[0]).toMatch(/decoded/i)
  })

  it('reports a rejected play() as an error rather than silently failing', async () => {
    media.failNextPlay = 'NotAllowedError'
    const token = engine.beginLoad('a')
    const ok = await engine.load(token, 'http://local/a')
    expect(ok).toBe(false)
    expect(engine.snapshot().status).toBe('error')
  })

  it('applies volume, mute and rate to the element', () => {
    engine.setVolume(0.42)
    engine.setMuted(true)
    engine.setRate(1.5)
    expect(media.volume).toBeCloseTo(0.42)
    expect(media.muted).toBe(true)
    expect(media.playbackRate).toBe(1.5)
    engine.setVolume(5)
    expect(media.volume).toBe(1)
  })

  it('restart replays the current source from zero', async () => {
    const token = engine.beginLoad('a')
    await engine.load(token, 'http://local/a')
    media.setDuration(10)
    media.tick(9)
    engine.restart()
    expect(media.currentTime).toBe(0)
    expect(media.playCount).toBe(2)
  })
})
