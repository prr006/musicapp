import '@testing-library/jest-dom/vitest'

/**
 * jsdom ships no media pipeline. These shims give HTMLMediaElement the small
 * behavioural contract MELO relies on (play/pause/load + events) so
 * application-level tests exercise the real engine instead of a stub.
 */
const proto = window.HTMLMediaElement.prototype

Object.defineProperty(proto, 'play', {
  configurable: true,
  value(this: HTMLMediaElement) {
    if (!this.getAttribute('src')) return Promise.reject(new Error('no source'))
    Object.defineProperty(this, 'paused', { configurable: true, value: false })
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  },
})

Object.defineProperty(proto, 'pause', {
  configurable: true,
  value(this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true })
    this.dispatchEvent(new Event('pause'))
  },
})

Object.defineProperty(proto, 'load', {
  configurable: true,
  value() {},
})

let currentTime = 0
Object.defineProperty(proto, 'currentTime', {
  configurable: true,
  get() {
    return currentTime
  },
  set(value: number) {
    currentTime = value
  },
})

Object.defineProperty(proto, 'duration', {
  configurable: true,
  get() {
    return 120
  },
})

if (!('structuredClone' in globalThis)) {
  globalThis.structuredClone = ((v: unknown) => JSON.parse(JSON.stringify(v))) as typeof structuredClone
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

// jsdom does not implement scrollTo on elements.
Element.prototype.scrollTo = Element.prototype.scrollTo || (() => {})

// React 18 needs this flag for act() to be honoured outside of RTL's own calls.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
