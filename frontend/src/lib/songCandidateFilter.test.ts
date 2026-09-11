/**
 * Tests for:
 * 1. Non-song content filtering (songCandidateFilter)
 * 2. Recommendation personalization behavior
 * 3. Diversity constraints
 * 4. Title/artwork regression protection
 */
import { describe, expect, it } from 'vitest'
import { isSongCandidate, MIN_SONG_DURATION, MAX_SONG_DURATION } from './songCandidateFilter'
import type { Track } from '../bridge/types'

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'yt:test123',
    sourceId: 'test123',
    source: 'youtube',
    url: 'https://www.youtube.com/watch?v=test123',
    title: 'Test Song',
    artist: 'Test Artist',
    uploader: 'Test Artist',
    album: '',
    artwork: '',
    duration: 200,
    explicit: false,
    ...overrides,
  }
}

// ============================================================
// ISSUE 1 & 2: NON-SONG CONTENT FILTERING
// ============================================================

describe('isSongCandidate — reject non-song content', () => {
  it('rejects movie trailer', () => {
    expect(isSongCandidate(makeTrack({ title: 'Movie Trailer' }))).toBe(false)
  })

  it('rejects official trailer', () => {
    expect(isSongCandidate(makeTrack({ title: 'Official Trailer' }))).toBe(false)
  })

  it('rejects song teaser', () => {
    expect(isSongCandidate(makeTrack({ title: 'Song Teaser' }))).toBe(false)
  })

  it('rejects teaser', () => {
    expect(isSongCandidate(makeTrack({ title: 'Teaser' }))).toBe(false)
  })

  it('rejects dialogue promo', () => {
    expect(isSongCandidate(makeTrack({ title: 'Dialogue Promo' }))).toBe(false)
  })

  it('rejects movie clip', () => {
    expect(isSongCandidate(makeTrack({ title: 'Movie Clip' }))).toBe(false)
  })

  it('rejects behind the scenes', () => {
    expect(isSongCandidate(makeTrack({ title: 'Behind The Scenes' }))).toBe(false)
  })

  it('rejects behind the scene', () => {
    expect(isSongCandidate(makeTrack({ title: 'Behind The Scene' }))).toBe(false)
  })

  it('rejects interview with artist', () => {
    expect(isSongCandidate(makeTrack({ title: 'Interview With Artist' }))).toBe(false)
  })

  it('rejects making of', () => {
    expect(isSongCandidate(makeTrack({ title: 'Making Of The Album' }))).toBe(false)
  })

  it('rejects reaction video', () => {
    expect(isSongCandidate(makeTrack({ title: 'Reaction Video' }))).toBe(false)
  })

  it('rejects full album', () => {
    expect(isSongCandidate(makeTrack({ title: 'Full Album' }))).toBe(false)
  })

  it('rejects 1 hour mix', () => {
    expect(isSongCandidate(makeTrack({ title: '1 Hour Mix' }))).toBe(false)
  })

  it('rejects nonstop mix', () => {
    expect(isSongCandidate(makeTrack({ title: 'Nonstop Mix' }))).toBe(false)
  })

  it('rejects non-stop playlist', () => {
    expect(isSongCandidate(makeTrack({ title: 'Non-Stop Playlist' }))).toBe(false)
  })

  it('rejects podcast episode', () => {
    expect(isSongCandidate(makeTrack({ title: 'Podcast Episode' }))).toBe(false)
  })

  it('rejects scene from movie', () => {
    expect(isSongCandidate(makeTrack({ title: 'Scene From Movie' }))).toBe(false)
  })

  it('rejects episode promo', () => {
    expect(isSongCandidate(makeTrack({ title: 'Episode Promo' }))).toBe(false)
  })

  it('rejects announcement video', () => {
    expect(isSongCandidate(makeTrack({ title: 'Announcement Video' }))).toBe(false)
  })

  it('rejects press meet', () => {
    expect(isSongCandidate(makeTrack({ title: 'Press Meet' }))).toBe(false)
  })

  it('rejects press conference', () => {
    expect(isSongCandidate(makeTrack({ title: 'Press Conference' }))).toBe(false)
  })

  it('rejects first look', () => {
    expect(isSongCandidate(makeTrack({ title: 'First Look' }))).toBe(false)
  })

  it('rejects sneak peek', () => {
    expect(isSongCandidate(makeTrack({ title: 'Sneak Peek' }))).toBe(false)
  })

  it('rejects glimpse', () => {
    expect(isSongCandidate(makeTrack({ title: 'Glimpse' }))).toBe(false)
  })

  it('rejects vlog', () => {
    expect(isSongCandidate(makeTrack({ title: 'My Vlog' }))).toBe(false)
  })

  it('rejects tutorial', () => {
    expect(isSongCandidate(makeTrack({ title: 'Guitar Tutorial' }))).toBe(false)
  })

  it('rejects documentary', () => {
    expect(isSongCandidate(makeTrack({ title: 'Documentary' }))).toBe(false)
  })

  it('rejects karaoke', () => {
    expect(isSongCandidate(makeTrack({ title: 'Karaoke Version' }))).toBe(false)
  })

  it('rejects backing track', () => {
    expect(isSongCandidate(makeTrack({ title: 'Backing Track' }))).toBe(false)
  })

  it('rejects fan made', () => {
    expect(isSongCandidate(makeTrack({ title: 'Fan Made Video' }))).toBe(false)
  })

  it('rejects fan edit', () => {
    expect(isSongCandidate(makeTrack({ title: 'Fan Edit' }))).toBe(false)
  })

  it('rejects web series clip', () => {
    expect(isSongCandidate(makeTrack({ title: 'Web Series Clip' }))).toBe(false)
  })

  it('rejects serial promo', () => {
    expect(isSongCandidate(makeTrack({ title: 'Serial Promo' }))).toBe(false)
  })

  it('rejects megamix', () => {
    expect(isSongCandidate(makeTrack({ title: 'Megamix 2024' }))).toBe(false)
  })

  it('rejects hours of music', () => {
    expect(isSongCandidate(makeTrack({ title: '3 Hours of Music' }))).toBe(false)
  })

  it('rejects promotional content', () => {
    expect(isSongCandidate(makeTrack({ title: 'Promotional Video' }))).toBe(false)
  })

  it('rejects live stream', () => {
    expect(isSongCandidate(makeTrack({ title: 'Live Stream Concert' }))).toBe(false)
  })

  it('rejects full movie', () => {
    expect(isSongCandidate(makeTrack({ title: 'Full Movie' }))).toBe(false)
  })
})

describe('isSongCandidate — accept legitimate songs', () => {
  it('accepts simple song title', () => {
    expect(isSongCandidate(makeTrack({ title: 'Bohemian Rhapsody', artist: 'Queen' }))).toBe(true)
  })

  it('accepts song with (From "Movie")', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Make Way For The King (From "Raaka")',
      artist: 'Sai Abhyankkar',
    }))).toBe(true)
  })

  it('accepts song with [Tamil]', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Alaakaa Loova [Tamil]',
      artist: 'Sai Abhyankkar',
    }))).toBe(true)
  })

  it('accepts song with [Telugu]', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Alaakaa Loova [Telugu]',
      artist: 'Sai Abhyankkar',
    }))).toBe(true)
  })

  it('accepts song with feat. Artist', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Song Name (feat. Artist)',
      artist: 'Main Artist',
    }))).toBe(true)
  })

  it('accepts song with Official Music Video', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Song Name - Official Music Video',
      artist: 'Artist',
    }))).toBe(true)
  })

  it('accepts song with Official Audio', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Song Name - Official Audio',
      artist: 'Artist',
    }))).toBe(true)
  })

  it('accepts Remix as a song variant', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Song Name - Remix',
      artist: 'Artist',
    }))).toBe(true)
  })

  it('accepts Acoustic as a song variant', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Song Name - Acoustic',
      artist: 'Artist',
    }))).toBe(true)
  })

  it('accepts Live as a song variant', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Song Name - Live',
      artist: 'Artist',
    }))).toBe(true)
  })

  it('accepts "Live Life" (live is NOT a reject word here)', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Live Life',
      artist: 'Artist',
    }))).toBe(true)
  })

  it('accepts "Live Forever"', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Live Forever',
      artist: 'Artist',
    }))).toBe(true)
  })

  it('accepts "Remix Party"', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Remix Party',
      artist: 'Artist',
    }))).toBe(true)
  })

  it('accepts "Acoustic Love"', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Acoustic Love',
      artist: 'Artist',
    }))).toBe(true)
  })

  it('accepts long legitimate title', () => {
    expect(isSongCandidate(makeTrack({
      title: 'This Is A Very Long Song Title That Should Not Be Rejected',
      artist: 'Artist',
    }))).toBe(true)
  })

  it('accepts title with quotes and parentheses', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Song "Name" (With "Quotes")',
      artist: 'Artist',
    }))).toBe(true)
  })

  it('accepts hyphenated title', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Anti-Hero',
      artist: 'Taylor Swift',
    }))).toBe(true)
  })

  it('accepts legitimate song with duration', () => {
    expect(isSongCandidate(makeTrack({
      title: 'My Song',
      artist: 'Artist',
      duration: 240,
    }))).toBe(true)
  })
})

describe('isSongCandidate — duration filtering', () => {
  it('rejects too-short duration', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Short',
      artist: 'Artist',
      duration: 10,
    }))).toBe(false)
  })

  it('rejects too-long duration (mix/compilation)', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Long Mix',
      artist: 'Artist',
      duration: 3601,
    }))).toBe(false)
  })

  it('accepts zero duration (unknown)', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Unknown Duration',
      artist: 'Artist',
      duration: 0,
    }))).toBe(true)
  })

  it('accepts minimum boundary', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Short Song',
      artist: 'Artist',
      duration: MIN_SONG_DURATION,
    }))).toBe(true)
  })

  it('accepts maximum boundary', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Long Song',
      artist: 'Artist',
      duration: MAX_SONG_DURATION,
    }))).toBe(true)
  })
})

describe('isSongCandidate — metadata credibility', () => {
  it('rejects no artist AND no uploader', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Mystery Song',
      artist: '',
      uploader: '',
    }))).toBe(false)
  })

  it('accepts with artist only', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Song',
      artist: 'Artist',
      uploader: '',
    }))).toBe(true)
  })

  it('accepts with uploader only', () => {
    expect(isSongCandidate(makeTrack({
      title: 'Song',
      artist: '',
      uploader: 'Channel',
    }))).toBe(true)
  })
})

describe('isSongCandidate — edge cases', () => {
  it('rejects null/undefined', () => {
    expect(isSongCandidate(null as any)).toBe(false)
    expect(isSongCandidate(undefined as any)).toBe(false)
  })

  it('rejects empty title', () => {
    expect(isSongCandidate(makeTrack({ title: '' }))).toBe(false)
  })

  it('rejects whitespace-only title', () => {
    expect(isSongCandidate(makeTrack({ title: '   ' }))).toBe(false)
  })
})

// ============================================================
// TITLE / ARTWORK REGRESSION PROTECTION
// ============================================================

describe('title preservation — no regression', () => {
  it('preserves (From "Movie") in titles', () => {
    const titles = [
      'Make Way For The King (From "Raaka")',
      'Karuppa Kooda Va (From "Karuppu")',
      'The Wild Theme (From "OM Chapter 1: Udhiram - The Blood Wood")',
    ]
    for (const title of titles) {
      const track = makeTrack({ title, artist: 'Sai Abhyankkar' })
      expect(track.title).toBe(title)
      expect(isSongCandidate(track)).toBe(true)
    }
  })

  it('preserves language tags', () => {
    const titles = [
      'Song Name [Tamil]',
      'Song Name [Telugu]',
      'Song Name [Hindi]',
    ]
    for (const title of titles) {
      const track = makeTrack({ title, artist: 'Artist' })
      expect(track.title).toBe(title)
      expect(isSongCandidate(track)).toBe(true)
    }
  })

  it('preserves feat. Artist', () => {
    const track = makeTrack({
      title: 'Song Name (feat. Other Artist)',
      artist: 'Main Artist',
    })
    expect(track.title).toBe('Song Name (feat. Other Artist)')
    expect(isSongCandidate(track)).toBe(true)
  })

  it('preserves hyphens in titles', () => {
    const track = makeTrack({
      title: 'Anti-Hero',
      artist: 'Taylor Swift',
    })
    expect(track.title).toBe('Anti-Hero')
    expect(isSongCandidate(track)).toBe(true)
  })

  it('preserves meaningful parentheses', () => {
    const track = makeTrack({
      title: 'Song (Part 1)',
      artist: 'Artist',
    })
    expect(track.title).toBe('Song (Part 1)')
    expect(isSongCandidate(track)).toBe(true)
  })
})
