/**
 * Tests for the YouTube Music timed-lyrics fallback (lib/ytmusic.ts).
 *
 * The fallback must never return one song's timed lyrics for another
 * song's query: duration alone cannot identify a recording (two songs
 * from the same movie routinely share a length), so the top YTM match
 * must also overlap the query title.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchYtmTimedLyrics } from './ytmusic'

function searchPayload(title: string, artist: string, videoId: string, lengthText: string) {
  return {
    contents: {
      items: [
        {
          musicResponsiveListItemRenderer: {
            flexColumns: [
              {
                musicResponsiveListItemFlexColumnRenderer: {
                  text: { runs: [{ text: title }] },
                },
              },
              {
                musicResponsiveListItemFlexColumnRenderer: {
                  text: { runs: [{ text: artist }] },
                },
              },
            ],
            fixedColumns: {
              musicResponsiveListItemFixedColumnRenderer: {
                text: { runs: [{ text: lengthText }] },
              },
            },
            playlistItemData: { videoId },
          },
        },
      ],
    },
  }
}

function nextPayload(browseId: string) {
  return {
    tabs: [
      {
        browseEndpoint: {
          browseId,
          browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_TRACK_LYRICS' },
        },
      },
    ],
  }
}

function browsePayload(lines: { ms: number; text: string }[]) {
  return {
    timedLyricsModel: {
      lyricsData: {
        timedLyricsData: lines.map((l) => ({
          cueRange: { startTimeMilliseconds: l.ms },
          lyricLine: l.text,
        })),
      },
    },
  }
}

function stubInnerTube(matchTitle: string, lengthText = '3:50') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const text = String(url)
      if (text.includes('/search')) {
        return new Response(
          JSON.stringify(searchPayload(matchTitle, 'Sooraj Santhosh & MM Manasi', '1kqpUuxomK0', lengthText)),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (text.includes('/next')) {
        return new Response(JSON.stringify(nextPayload('MPLYt_test123')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify(
          browsePayload([
            { ms: 35370, text: 'Line one' },
            { ms: 38990, text: 'Line two' },
          ]),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }),
  )
}

describe('fetchYtmTimedLyrics — title gate', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects a same-duration different song (Aagadu query vs Bhel Poori match)', async () => {
    // Real failure mode: YTM search for "Aagadu" surfaces "Bhel Poori"
    // (same movie, 230s vs 241s — inside the duration tolerance). Without
    // a title check its 57 timed Telugu lines would be returned as
    // "Aagadu" lyrics.
    stubInnerTube('Bhel Poori')
    const result = await fetchYtmTimedLyrics('Aagadu', 'Thaman S', 241)
    expect(result).toBeNull()
  })

  it('accepts the match when the title overlaps', async () => {
    stubInnerTube('Bhel Poori')
    const result = await fetchYtmTimedLyrics('Bhel Poori', 'Thaman S', 241)
    expect(result).not.toBeNull()
    expect(result?.synced).toHaveLength(2)
    expect(result?.synced[0].text).toBe('Line one')
  })

  it('accepts when the match title contains the query title', async () => {
    stubInnerTube('Theme Of Aagadu', '1:44')
    const result = await fetchYtmTimedLyrics('Aagadu', 'Thaman S', 104)
    expect(result).not.toBeNull()
    expect(result?.synced).toHaveLength(2)
  })
})
