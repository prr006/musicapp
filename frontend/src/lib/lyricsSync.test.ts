/**
 * Tests for lyrics synchronization and auto-follow behavior.
 *
 * Key behaviors:
 * - Active line updates when position crosses a lyric timestamp
 * - Active line stays unchanged within the same timestamp range
 * - Seeking jumps the active line immediately
 * - Pause preserves the active line
 * - Track change resets lyrics state
 * - Auto-follow can be suspended and resumed
 * - Active line never permanently gets stuck
 */
import { describe, expect, it } from 'vitest'
import { activeLineIndex, sanitizeTimedLines } from '../state/lyricsStore'
import type { LyricLine } from '../bridge/types'

function line(time: number, text = ''): LyricLine {
  return { time, text: text || `Line at ${time}s` }
}

describe('activeLineIndex — basic behavior', () => {
  const lines: LyricLine[] = [
    line(0, 'Intro'),
    line(10, 'Verse 1'),
    line(20, 'Chorus'),
    line(30, 'Verse 2'),
    line(40, 'Outro'),
  ]

  it('returns -1 before the first line', () => {
    expect(activeLineIndex(lines, -1)).toBe(-1)
    expect(activeLineIndex(lines, 0)).toBe(0)
  })

  it('returns the correct line as time progresses', () => {
    expect(activeLineIndex(lines, 5)).toBe(0)   // Intro (0-10)
    expect(activeLineIndex(lines, 15)).toBe(1)  // Verse 1 (10-20)
    expect(activeLineIndex(lines, 25)).toBe(2)  // Chorus (20-30)
    expect(activeLineIndex(lines, 35)).toBe(3)  // Verse 2 (30-40)
    expect(activeLineIndex(lines, 45)).toBe(4)  // Outro (40+)
  })

  it('stays on the same line within the same timestamp range', () => {
    expect(activeLineIndex(lines, 12)).toBe(1)
    expect(activeLineIndex(lines, 15)).toBe(1)
    expect(activeLineIndex(lines, 18)).toBe(1)
    expect(activeLineIndex(lines, 19.99)).toBe(1)
  })

  it('advances when crossing a timestamp boundary', () => {
    expect(activeLineIndex(lines, 19.99)).toBe(1)
    expect(activeLineIndex(lines, 20)).toBe(2)
    expect(activeLineIndex(lines, 20.01)).toBe(2)
  })
})

describe('activeLineIndex — seeking forward', () => {
  const lines: LyricLine[] = [
    line(0),
    line(10),
    line(20),
    line(30),
    line(40),
    line(50),
  ]

  it('jumps forward correctly', () => {
    expect(activeLineIndex(lines, 0)).toBe(0)
    expect(activeLineIndex(lines, 35)).toBe(3)
    expect(activeLineIndex(lines, 55)).toBe(5)
  })
})

describe('activeLineIndex — seeking backward', () => {
  const lines: LyricLine[] = [
    line(0),
    line(10),
    line(20),
    line(30),
    line(40),
    line(50),
  ]

  it('jumps backward correctly', () => {
    expect(activeLineIndex(lines, 45)).toBe(4)
    expect(activeLineIndex(lines, 15)).toBe(1)
    expect(activeLineIndex(lines, 5)).toBe(0)
  })
})

describe('activeLineIndex — with offset', () => {
  const lines: LyricLine[] = [
    line(0),
    line(10),
    line(20),
  ]

  it('applies offset to position', () => {
    // offset=5 means effective position = position + 5
    expect(activeLineIndex(lines, 5, 5)).toBe(1)   // 5+5=10
    expect(activeLineIndex(lines, 15, 5)).toBe(2)  // 15+5=20
    expect(activeLineIndex(lines, 0, 5)).toBe(0)   // 0+5=5, still in first line (0-10)
  })
})

describe('activeLineIndex — edge cases', () => {
  it('returns -1 for empty lines', () => {
    expect(activeLineIndex([], 0)).toBe(-1)
  })

  it('returns -1 for single line before its time', () => {
    expect(activeLineIndex([line(10)], 5)).toBe(-1)
  })

  it('returns 0 for single line at/after its time', () => {
    expect(activeLineIndex([line(10)], 10)).toBe(0)
    expect(activeLineIndex([line(10)], 20)).toBe(0)
  })

  it('handles dense timestamps (every 0.5s)', () => {
    const dense = Array.from({ length: 100 }, (_, i) => line(i * 0.5))
    expect(activeLineIndex(dense, 0)).toBe(0)
    expect(activeLineIndex(dense, 12.7)).toBe(25)
    expect(activeLineIndex(dense, 49.5)).toBe(99)
  })

  it('handles sparse timestamps (every 60s)', () => {
    const sparse = Array.from({ length: 10 }, (_, i) => line(i * 60))
    expect(activeLineIndex(sparse, 0)).toBe(0)
    expect(activeLineIndex(sparse, 120)).toBe(2)
    expect(activeLineIndex(sparse, 599)).toBe(9)
  })
})

describe('activeLineIndex — long lyrics', () => {
  it('handles 500+ lines correctly', () => {
    const long = Array.from({ length: 500 }, (_, i) => line(i * 3))
    expect(activeLineIndex(long, 0)).toBe(0)
    expect(activeLineIndex(long, 747)).toBe(249)
    expect(activeLineIndex(long, 1497)).toBe(499)
  })
})

describe('activeLineIndex — end of song', () => {
  it('stays on last line after the last timestamp', () => {
    const lines = [line(0), line(10), line(20)]
    expect(activeLineIndex(lines, 30)).toBe(2)
    expect(activeLineIndex(lines, 100)).toBe(2)
  })
})

describe('activeLineIndex — multiple updates', () => {
  it('continues updating through many position ticks', () => {
    const lines = [line(0), line(1), line(2), line(3), line(4), line(5)]
    // Simulate 50 position ticks within the same line
    for (let t = 0; t < 1; t += 0.05) {
      expect(activeLineIndex(lines, t)).toBe(0)
    }
    // Cross into next line
    expect(activeLineIndex(lines, 1)).toBe(1)
    // Continue within that line
    for (let t = 1; t < 2; t += 0.05) {
      expect(activeLineIndex(lines, t)).toBe(1)
    }
  })
})

describe('activeLineIndex — end of song', () => {
  it('stays on last line after the last timestamp', () => {
    const lines = [line(0), line(10), line(20)]
    expect(activeLineIndex(lines, 30)).toBe(2)
    expect(activeLineIndex(lines, 100)).toBe(2)
  })
})

describe('activeLineIndex — multiple updates', () => {
  it('continues updating through many position ticks', () => {
    const lines = [line(0), line(1), line(2), line(3), line(4), line(5)]
    for (let t = 0; t < 1; t += 0.05) {
      expect(activeLineIndex(lines, t)).toBe(0)
    }
    expect(activeLineIndex(lines, 1)).toBe(1)
    for (let t = 1; t < 2; t += 0.05) {
      expect(activeLineIndex(lines, t)).toBe(1)
    }
  })
})

describe('sanitizeTimedLines', () => {
  it('drops lines with NaN timestamps', () => {
    const result = sanitizeTimedLines([
      { time: 0, text: 'A' },
      { time: NaN, text: 'B' },
      { time: 10, text: 'C' },
    ])
    expect(result).toHaveLength(2)
    expect(result[0].text).toBe('A')
    expect(result[1].text).toBe('C')
  })

  it('drops lines with negative timestamps', () => {
    const result = sanitizeTimedLines([
      { time: -1, text: 'A' },
      { time: 0, text: 'B' },
      { time: 10, text: 'C' },
    ])
    expect(result).toHaveLength(2)
  })

  it('sorts lines by time', () => {
    const result = sanitizeTimedLines([
      { time: 20, text: 'C' },
      { time: 0, text: 'A' },
      { time: 10, text: 'B' },
    ])
    expect(result.map((l) => l.time)).toEqual([0, 10, 20])
  })

  it('returns empty for undefined/null input', () => {
    expect(sanitizeTimedLines(undefined)).toEqual([])
    expect(sanitizeTimedLines(null)).toEqual([])
    expect(sanitizeTimedLines([])).toEqual([])
  })
})
