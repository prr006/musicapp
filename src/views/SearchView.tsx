/**
 * Global search (spec §5/§28): grouped results, loading/empty/error states,
 * keyboard navigation, direct play / queue actions.
 * In the real app search returns an honest Phase-5 error until yt-dlp lands.
 */

import { useEffect, useRef, useState } from "react";

import * as api from "@/app/api";
import { Artwork } from "@/components/Artwork";
import { TrackList } from "@/components/TrackList";
import { getBridge } from "@/app/ipc";
import { useSearchHistory } from "@/app/stores/library";
import { setSearchQuery, pushToast } from "@/app/stores/ui";
import type { SearchResults } from "@/types/domain";

function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; results: SearchResults };

export function SearchView({ query }: { query: string }) {
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [cursor, setCursor] = useState(0);
  const isMock = getBridge().kind === "mock";
  const history = useSearchHistory();
  const latestRef = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setState({ kind: "idle" });
      return;
    }
    const latest = ++latestRef.current;
    setState({ kind: "loading" });
    const timer = setTimeout(() => {
      api.search(q, 20)
        .then((results) => {
          if (latest !== latestRef.current) return; // stale response
          setState({ kind: "done", results });
          setCursor(0);
        })
        .catch((e) => {
          if (latest !== latestRef.current) return;
          setState({
            kind: "error",
            message: e instanceof Error ? e.message : "Search failed.",
          });
        });
    }, 160); // debounce rapid typing; never blocks playback (spec §28)
    return () => clearTimeout(timer);
  }, [query]);

  const total =
    state.kind === "done"
      ? state.results.tracks.length +
        state.results.artists.length +
        state.results.albums.length
      : 0;

  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, total - 1))), [total]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (state.kind !== "done") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, total - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      const track = state.results.tracks[cursor];
      if (track) void api.playNow(track);
    }
  }

  return (
    <div tabIndex={-1} onKeyDown={onKeyDown} style={{ outline: "none" }}>
      {state.kind === "idle" && (
        <div className="state-block">
          <div className="big">⌕</div>
          <h3>Search everything</h3>
          <p>
            Songs, artists, albums, playlists. Press <kbd>Ctrl K</kbd> anywhere.
            {isMock && " In the browser preview, append “err” to see failure states."}
          </p>
          {history.length > 0 && (
            <div className="chip-row" style={{ justifyContent: "center", marginTop: 14 }}>
              {history.slice(0, 8).map((q) => (
                <button key={q} className="chip" onClick={() => setSearchQuery(q)}>
                  {q}
                </button>
              ))}
              <button
                className="chip subtle"
                title="Clear search history"
                onClick={() =>
                  void api.clearSearchHistory().catch((e) => pushToast(String(e), "error"))
                }
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      {state.kind === "loading" && (
        <div className="state-block">
          <div className="spinner" />
          <p>Searching “{query}”…</p>
        </div>
      )}

      {state.kind === "error" && (
          <div className="state-block">
          <div className="big">⚠</div>
          <h3>Couldn't search right now</h3>
          <p>{state.message}</p>
          <button
            className="button"
            onClick={() => {
              setState({ kind: "loading" });
              api
                .search(query.trim(), 20)
                .then((r) => setState({ kind: "done", results: r }))
                .catch((err) =>
                  setState({ kind: "error", message: String(err) }),
                );
            }}
          >
            Retry
          </button>
        </div>
      )}

      {state.kind === "done" && total === 0 && (
        <div className="state-block">
          <div className="big">∅</div>
          <h3>No results for “{state.results.query}”</h3>
          <p>Check the spelling, or try different keywords.</p>
        </div>
      )}

      {state.kind === "done" && state.results.tracks.length > 0 && (
        <div className="search-group">
          <h3>Songs</h3>
          <TrackList tracks={state.results.tracks} />
          <p style={{ color: "var(--text-faint)", fontSize: 12, margin: "10px 2px" }}>
            ↑↓ to navigate · Enter to play
          </p>
        </div>
      )}

      {state.kind === "done" && state.results.artists.length > 0 && (
        <div className="search-group">
          <h3>Artists</h3>
          <div className="grid">
            {state.results.artists.map((artist) => (
              <button
                key={artist.id}
                className="card"
                onClick={() =>
                  pushToast(`Artist pages arrive in Phase 5 — ${artist.name}`, "info")
                }
              >
                <div
                  style={{
                    width: 148,
                    height: 148,
                    borderRadius: 999,
                    background: "linear-gradient(135deg, var(--accent), var(--accent-strong))",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 40,
                    fontWeight: 800,
                    color: "rgba(255,255,255,0.9)",
                  }}
                  aria-hidden="true"
                >
                  {artist.name.slice(0, 1)}
                </div>
                <div className="card-title">{artist.name}</div>
                <div className="card-sub">
                  Artist{artist.followerCount ? ` · ${formatFollowers(artist.followerCount)} followers` : ""}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {state.kind === "done" && state.results.albums.length > 0 && (
        <div className="search-group">
          <h3>Albums</h3>
          <div className="grid">
            {state.results.albums.map((album) => (
              <button
                key={album.id}
                className="card"
                onClick={() => {
                  const tracks = state.results.tracks.filter(
                    (t) => t.album?.id === album.id,
                  );
                  if (tracks.length > 0) void api.startSequence(tracks, false);
                  else pushToast("Album pages arrive in Phase 5", "info");
                }}
              >
                <Artwork
                  track={state.results.tracks.find((t) => t.album?.id === album.id) ?? null}
                  size={148}
                  rounded={12}
                />
                <div className="card-title">{album.title}</div>
                <div className="card-sub">
                  {album.year ?? ""} · {album.artists.map((a) => a.name).join(", ")}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
