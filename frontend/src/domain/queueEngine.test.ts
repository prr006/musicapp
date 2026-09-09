import { describe, expect, it } from 'vitest'
import type { Track } from '../bridge/types'
import { normalizeTitle } from '../lib/discovery'
import {
  appendDiscovery,
  buildDiscoveryBlock,
  DISCOVERY_TARGET,
  prefetchCandidates,
  projectUpcoming,
  reconcileDiscovery,
  selectNextTrack,
  type QueueStateLike,
} from './queueEngine'

function track(id: string, title = `Song ${id}`): Track {
  return {
    id: `yt:${id}`,
    sourceId: id,
    source: 'youtube',
    url: `https://youtube.com/watch?v=${id}`,
    title,
    artist: `Artist ${id}`,
    album: 'Album',
    artwork: '',
    duration: 180,
    explicit: false,
  }
}

function state(patch: Partial<QueueStateLike> = {}): QueueStateLike {
  return {
    current: track('current'),
    queue: [track('current')],
    autoQueue: [],
    index: 0,
    playingFrom: 'queue',
    repeat: 'off',
    ...patch,
  }
}

describe('canonical desktop/web queue engine', () => {
  it('always selects explicit upcoming tracks before discovery', () => {
    const thunder = track('thunder')
    const demons = track('demons')
    const discovery = track('radio')
    const model = state({
      queue: [track('current'), thunder, demons],
      autoQueue: [discovery],
    })

    expect(selectNextTrack(model, true)).toEqual({
      track: thunder,
      source: 'queue',
      queueIndex: 1,
    })
  })

  it('projects the real UI order with explicit and discovery sections separated', () => {
    const thunder = track('thunder')
    const demons = track('demons')
    const radio = track('radio')
    const projected = projectUpcoming({
      queue: [track('current'), thunder, demons],
      autoQueue: [radio],
      index: 0,
    })

    expect(projected.explicit).toEqual([thunder, demons])
    expect(projected.discovery).toEqual([radio])
    expect(projected.all).toEqual([thunder, demons, radio])
  })

  it('appends a refill without replacing or reordering existing discovery', () => {
    const existing = [track('one'), track('two')]
    const candidates = [track('three'), track('four')]
    const block = buildDiscoveryBlock({
      state: { current: track('current'), queue: [track('current')], autoQueue: existing },
    })
    const result = appendDiscovery(existing, candidates, block)

    expect(result.queue.slice(0, existing.length)).toEqual(existing)
    expect(result.queue).toEqual([...existing, ...candidates])
    expect(result.queue).not.toBe(existing)
  })

  it('keeps the visible buffer intact while a refill has not produced candidates', () => {
    const existing = [track('one'), track('two'), track('three')]
    const block = buildDiscoveryBlock({
      state: { current: track('current'), queue: [track('current')], autoQueue: existing },
    })

    expect(appendDiscovery(existing, [], block)).toEqual({ queue: existing, added: [] })
  })

  it('rejects canonical duplicates across queues, history and the active radio session', () => {
    const explicit = track('explicit', 'Believer')
    const history = track('history', 'Thunder (Official Video)')
    const seenTitle = normalizeTitle('Demons')
    const block = buildDiscoveryBlock({
      state: { current: track('current'), queue: [track('current'), explicit], autoQueue: [] },
      history: [{ track: history, playedAt: 1 }],
      radioSeen: { ids: new Set(['yt:seen-id']), titles: new Set([seenTitle]) },
    })
    const result = appendDiscovery([], [
      track('believer-upload', 'Believer (Official Video)'),
      track('thunder-upload', 'Thunder'),
      track('demons-upload', 'Demons (Lyrics)'),
      track('seen-id', 'Different title'),
      track('fresh', 'Bad Liar'),
    ], block)

    expect(result.added.map((candidate) => candidate.id)).toEqual(['yt:fresh'])
  })

  it('applies diversity only to discovery and never edits same-artist explicit entries', () => {
    const current = track('current', 'Current')
    const explicit = [
      { ...track('manual-a', 'Manual A'), artist: current.artist },
      { ...track('manual-b', 'Manual B'), artist: current.artist },
      { ...track('manual-c', 'Manual C'), artist: current.artist },
    ]
    const queue = [current, ...explicit]
    const block = buildDiscoveryBlock({ state: { current, queue, autoQueue: [] } })
    const result = appendDiscovery([], [
      { ...track('radio-a', 'Radio A'), artist: current.artist },
      { ...track('radio-b', 'Radio B'), artist: current.artist },
      track('related', 'Related'),
    ], block)

    expect(queue).toEqual([current, ...explicit])
    expect(result.added.map((candidate) => candidate.id)).toEqual(['yt:related', 'yt:radio-a'])
  })

  it('uses identical decisions for equivalent desktop and web queue state', () => {
    const shared = state({
      queue: [track('current'), track('thunder'), track('demons')],
      autoQueue: [track('radio-one'), track('radio-two')],
    })
    const decisions = (['desktop', 'web'] as const).map(() => ({
      next: selectNextTrack(shared, true),
      projected: projectUpcoming(shared),
      prefetched: prefetchCandidates(shared, true, DISCOVERY_TARGET),
      reconciled: reconcileDiscovery(
        shared.autoQueue,
        buildDiscoveryBlock({ state: { ...shared, autoQueue: [] } }),
      ),
    }))

    expect(decisions[0]).toEqual(decisions[1])
    expect(decisions[0].prefetched.map((candidate) => candidate.sourceId)).toEqual([
      'thunder', 'demons', 'radio-one', 'radio-two',
    ])
  })
})
