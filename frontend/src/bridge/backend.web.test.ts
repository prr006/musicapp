import { afterEach, describe, expect, it } from 'vitest'
import { backend, hasNativeBackend, initBackend, setBackend } from './backend'

/**
 * A browser deployment (dev server, CI, or the public static web build) has
 * no Wails bindings: the app must boot on the fixture backend — never on the
 * "unavailable" stub — because there is no web API in this architecture.
 */
describe('web (browser) backend selection', () => {
  afterEach(() => {
    setBackend(null)
  })

  it('detects the absence of native bindings', () => {
    expect(hasNativeBackend()).toBe(false)
  })

  it('initBackend resolves to the fixture backend outside the native shell', async () => {
    const be = await initBackend()
    expect(be.isNative).toBe(false)

    const state = await be.getState()
    expect(state.settings).toBeDefined()
    expect(Array.isArray(state.history)).toBe(true)

    const res = await be.search('kolaveri', 'songs')
    expect(res.songs.length).toBeGreaterThan(0)
    expect(res.songs[0].id).toBeTruthy()
  })

  it('exposes the fixture through backend() once initialised', async () => {
    const be = await initBackend()
    expect(backend()).toBe(be)
  })
})
