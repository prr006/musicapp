/**
 * Tests for YouTube title cleaning and artist/title splitting.
 *
 * The title parser must be extremely conservative:
 * - PRESERVE meaningful content: (From "Raaka"), feat. Artist, Part 1, Remix
 * - REMOVE only obvious presentation noise: (Official Video), (Lyrics), (HD)
 * - NEVER split titles on hyphens that are part of the actual song name
 */
import { describe, expect, it } from 'vitest'
import { cleanYouTubeTitle, parsePipedItem } from './webProvider'
import type { PipedStreamItem } from './webProvider'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('cleanYouTubeTitle', () => {
  it('removes (Official Music Video)', () => {
    expect(cleanYouTubeTitle('Song Title (Official Music Video)')).toBe('Song Title')
  })

  it('removes (Official Audio)', () => {
    expect(cleanYouTubeTitle('Song Title (Official Audio)')).toBe('Song Title')
  })

  it('removes (Official Video)', () => {
    expect(cleanYouTubeTitle('Song Title (Official Video)')).toBe('Song Title')
  })

  it('removes (Lyrics)', () => {
    expect(cleanYouTubeTitle('Song Title (Lyrics)')).toBe('Song Title')
  })

  it('removes (Lyric Video)', () => {
    expect(cleanYouTubeTitle('Song Title (Lyric Video)')).toBe('Song Title')
  })

  it('removes (HD)', () => {
    expect(cleanYouTubeTitle('Song Title (HD)')).toBe('Song Title')
  })

  it('removes (4K)', () => {
    expect(cleanYouTubeTitle('Song Title (4K)')).toBe('Song Title')
  })

  it('removes (Audio)', () => {
    expect(cleanYouTubeTitle('Song Title (Audio)')).toBe('Song Title')
  })

  it('removes (Visualizer)', () => {
    expect(cleanYouTubeTitle('Song Title (Visualizer)')).toBe('Song Title')
  })

  it('removes trailing " - Topic"', () => {
    expect(cleanYouTubeTitle('Artist Name - Topic')).toBe('Artist Name')
  })

  it('preserves (From "Raaka")', () => {
    expect(cleanYouTubeTitle('Make Way For The King (From "Raaka")')).toBe('Make Way For The King (From "Raaka")')
  })

  it('preserves (From "Karuppu")', () => {
    expect(cleanYouTubeTitle('Karuppa Kooda Va (From "Karuppu")')).toBe('Karuppa Kooda Va (From "Karuppu")')
  })

  it('preserves (From "OM Chapter 1: Udh...")', () => {
    expect(cleanYouTubeTitle('The Wild Theme (From "OM Chapter 1: Udh...")')).toBe('The Wild Theme (From "OM Chapter 1: Udh...")')
  })

  it('preserves feat. Artist', () => {
    expect(cleanYouTubeTitle('Song Title (feat. Artist Name)')).toBe('Song Title (feat. Artist Name)')
  })

  it('preserves ft. Artist', () => {
    expect(cleanYouTubeTitle('Song Title ft. Artist Name')).toBe('Song Title ft. Artist Name')
  })

  it('preserves Part 1', () => {
    expect(cleanYouTubeTitle('Song Title (Part 1)')).toBe('Song Title (Part 1)')
  })

  it('preserves Chapter 1', () => {
    expect(cleanYouTubeTitle('Song Title (Chapter 1)')).toBe('Song Title (Chapter 1)')
  })

  it('preserves Remix', () => {
    expect(cleanYouTubeTitle('Song Title (Remix)')).toBe('Song Title (Remix)')
  })

  it('preserves Acoustic', () => {
    expect(cleanYouTubeTitle('Song Title (Acoustic)')).toBe('Song Title (Acoustic)')
  })

  it('preserves Live', () => {
    expect(cleanYouTubeTitle('Song Title (Live)')).toBe('Song Title (Live)')
  })

  it('preserves legitimate hyphens in titles', () => {
    expect(cleanYouTubeTitle('Anti-Hero')).toBe('Anti-Hero')
  })

  it('preserves titles with quotes', () => {
    expect(cleanYouTubeTitle("Don't Stop Me Now")).toBe("Don't Stop Me Now")
  })

  it('handles multiple suffixes', () => {
    expect(cleanYouTubeTitle('Song Title (Official Music Video) (HD)')).toBe('Song Title')
  })

  it('handles mixed presentation and meaningful content', () => {
    expect(cleanYouTubeTitle('Song Title (From "Movie") (Official Video)')).toBe('Song Title (From "Movie")')
  })

  it('handles bracket variants', () => {
    expect(cleanYouTubeTitle('Song Title [Official Video]')).toBe('Song Title')
  })

  it('does not strip partial matches', () => {
    expect(cleanYouTubeTitle('Official Video Song')).toBe('Official Video Song')
  })

  it('handles empty input', () => {
    expect(cleanYouTubeTitle('')).toBe('')
  })

  it('handles whitespace', () => {
    expect(cleanYouTubeTitle('  Song Title  (Lyrics)  ')).toBe('Song Title')
  })
})

describe('parsePipedItem — title preservation', () => {
  function makeItem(overrides: Partial<PipedStreamItem> = {}): PipedStreamItem {
    return {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Test Song',
      type: 'stream',
      duration: 200,
      ...overrides,
    }
  }

  it('preserves (From "Raaka") in title', () => {
    const track = parsePipedItem(makeItem({ title: 'Make Way For The King (From "Raaka")' }), false)
    expect(track?.title).toBe('Make Way For The King (From "Raaka")')
  })

  it('preserves (From "Karuppu") in title', () => {
    const track = parsePipedItem(makeItem({ title: 'Karuppa Kooda Va (From "Karuppu")' }), false)
    expect(track?.title).toBe('Karuppa Kooda Va (From "Karuppu")')
  })

  it('preserves feat. in title', () => {
    const track = parsePipedItem(makeItem({ title: 'Song Name (feat. Artist)' }), false)
    expect(track?.title).toBe('Song Name (feat. Artist)')
  })

  it('preserves hyphens in title', () => {
    const track = parsePipedItem(makeItem({ title: 'Anti-Hero' }), false)
    expect(track?.title).toBe('Anti-Hero')
  })

  it('strips (Official Video) but preserves rest', () => {
    const track = parsePipedItem(makeItem({ title: 'My Song (Official Video)' }), false)
    expect(track?.title).toBe('My Song')
  })

  it('uses uploaderName as artist for YouTube Music results', () => {
    const track = parsePipedItem(makeItem({
      title: 'Artist Name - Song Title',
      uploaderName: 'Artist Name',
    }), true)
    expect(track?.artist).toBe('Artist Name')
    expect(track?.title).toBe('Song Title')
  })

  it('preserves full title when no clean split possible', () => {
    const track = parsePipedItem(makeItem({ title: 'A Beautiful Song With Hyphens-And-More' }), false)
    expect(track?.title).toBe('A Beautiful Song With Hyphens-And-More')
  })

  it('handles long complete titles', () => {
    const longTitle = 'This Is A Very Long Song Title That Should Not Be Truncated Or Modified In Any Way'
    const track = parsePipedItem(makeItem({ title: longTitle }), false)
    expect(track?.title).toBe(longTitle)
  })

  it('handles titles with quotes and parentheses', () => {
    const track = parsePipedItem(makeItem({ title: 'Song "Name" (With "Quotes")' }), false)
    expect(track?.title).toBe('Song "Name" (With "Quotes")')
  })

  it('handles malformed/duplicate punctuation', () => {
    const track = parsePipedItem(makeItem({ title: 'Song Title ((Official Video))' }), false)
    expect(track?.title).toBe('Song Title')
  })
})
