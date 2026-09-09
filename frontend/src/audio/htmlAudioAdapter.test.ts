import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../bridge/types'
import { HtmlAudioAdapter } from './htmlAudioAdapter'
import { FakeMedia } from '../test/fakeMedia'

function track(id: string): Track {
  return {
    id: `yt:${id}`,
    sourceId: id,
    source: 'youtube',
    url: `http://local/${id}`,
    title: `Song ${id.toUpperCase()}`,
    artist: 'Artist',
    album: 'Album',
    artwork: `http://img/${id}.jpg`,
    duration: 100,
    explicit: false,
  }
}

describe('HtmlAudioAdapter', () => {
  let media: FakeMedia
  let adapter: HtmlAudioAdapter

  beforeEach(() => {
    media = new FakeMedia()
    adapter = new HtmlAudioAdapter(media.asElement())
  })

  it('clears the previous source the moment a new load begins', async () => {
    const first = adapter.beginLoad('yt:a')
    await adapter.load(first, track('a'))
    expect(media.src).toBe('http://local/a')
    expect(adapter.snapshot().status).toBe('playing')

    adapter.beginLoad('yt:b')
    // Old audio must be gone before the new source is known.
    expect(media.src).toBe('')
    expect(media.paused).toBe(true)
    expect(adapter.snapshot().trackId).toBe('yt:b')
    expect(adapter.snapshot().status).toBe('loading')
  })

  it('refuses a stale load token', async () => {
    const staleToken = adapter.beginLoad('yt:a')
    const freshToken = adapter.beginLoad('yt:b')
    await adapter.load(freshToken, track('b'))

    const applied = await adapter.load(staleToken, track('a'))
    expect(applied).toBe(false)
    expect(media.src).toBe('http://local/b')
    expect(adapter.snapshot().trackId).toBe('yt:b')
  })

  it('reports ended exactly once for the loaded track', async () => {
    const events: string[] = []
    adapter.subscribe((e) => {
      if (e.type === 'ended') events.push(e.trackId)
    })
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    media.setDuration(10)
    media.endNaturally()
    expect(events).toEqual(['yt:a'])
  })

  it('does not emit ended after stop()', async () => {
    const ended = vi.fn()
    adapter.subscribe((e) => {
      if (e.type === 'ended') ended()
    })
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    adapter.stop()
    media.endNaturally()
    expect(ended).not.toHaveBeenCalled()
    expect(adapter.snapshot().status).toBe('idle')
    expect(adapter.snapshot().trackId).toBeNull()
  })

  it('publishes the media element position, never a synthetic clock', async () => {
    const positions: number[] = []
    adapter.subscribe((e) => {
      if (e.type === 'position') positions.push(e.position)
    })
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    media.setDuration(30)
    media.tick(4.5)
    media.tick(9)
    expect(positions).toContain(4.5)
    expect(positions).toContain(9)
    expect(adapter.position).toBe(9)
  })

  it('seek clamps to the media duration and republishes position', async () => {
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    media.setDuration(20)
    adapter.seek(45)
    expect(media.currentTime).toBe(20)
    adapter.seek(-5)
    expect(media.currentTime).toBe(0)
  })

  it('surfaces decode failures as a real error state', async () => {
    const errors: string[] = []
    adapter.subscribe((e) => {
      if (e.type === 'error') errors.push(e.message)
    })
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    media.failWith(3) // MEDIA_ERR_DECODE
    expect(adapter.snapshot().status).toBe('error')
    expect(errors[0]).toMatch(/decoded/i)
  })

  it('reports a rejected play() as an error rather than silently failing', async () => {
    media.failNextPlay = 'NotAllowedError'
    const token = adapter.beginLoad('yt:a')
    const ok = await adapter.load(token, track('a'))
    expect(ok).toBe(false)
    expect(adapter.snapshot().status).toBe('error')
  })

  it('fails a track with no playable source', async () => {
    const token = adapter.beginLoad('yt:a')
    const ok = await adapter.load(token, { ...track('a'), url: '' })
    expect(ok).toBe(false)
    expect(adapter.snapshot().status).toBe('error')
    expect(adapter.snapshot().error).toMatch(/no playable source/i)
  })

  it('applies volume, mute and rate to the element', () => {
    adapter.setVolume(0.42)
    adapter.setMuted(true)
    adapter.setRate(1.5)
    expect(media.volume).toBeCloseTo(0.42)
    expect(media.muted).toBe(true)
    expect(media.playbackRate).toBe(1.5)
    adapter.setVolume(5)
    expect(media.volume).toBe(1)
  })

  it('restart replays the current source from zero', async () => {
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    media.setDuration(10)
    media.tick(9)
    adapter.restart()
    expect(media.currentTime).toBe(0)
    expect(media.playCount).toBe(2)
  })
})
