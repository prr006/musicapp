import { describe, expect, it } from 'vitest'
import { normalizeTitle } from './discovery'

describe('normalizeTitle', () => {
  it('strips upload noise so covers/remixes of one song compare equal', () => {
    expect(normalizeTitle('Believer')).toBe(normalizeTitle('Believer (Official Video)'))
    expect(normalizeTitle('Believer')).toBe(normalizeTitle('Believer - Lyrics'))
    expect(normalizeTitle('Believer')).toBe(normalizeTitle('Believer (Remastered 2017)'))
    expect(normalizeTitle('Kun Faya Kun')).toBe(normalizeTitle('Kun Faya Kun (Full Video Song)'))
  })

  it('keeps meaningful song words untouched', () => {
    expect(normalizeTitle('Why This Kolaveri Di')).toBe(normalizeTitle('Why This Kolaveri Di'))
    expect(normalizeTitle('3 (song)')).not.toBe(normalizeTitle('Paper Lanterns'))
  })
})
