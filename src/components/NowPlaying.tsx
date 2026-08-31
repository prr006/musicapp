/**
 * Full-screen Now Playing (spec §9).
 * Lyrics highlighting is derived from the backend position stream (spec §11)
 * — the only clock is `playback://position`.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import * as api from "@/app/api";
import { Artwork } from "@/components/Artwork";
import { Icon } from "@/components/Icon";
import { useStore } from "@/app/store";
import { openNowPlaying } from "@/app/stores/ui";
import { playbackStore, positionStore } from "@/app/stores/playback";
import { trackColors } from "@/app/ipc/sampleData";
import { activeLineIndex } from "@/lib/lyrics";
import { formatTime } from "@/lib/format";
import { artistLine, type Lyrics } from "@/types/domain";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export function NowPlaying() {
  const status = useStore(playbackStore, (s) => s.status);
  const track = useStore(playbackStore, (s) => s.currentTrack);
  const volume = useStore(playbackStore, (s) => s.volume);
  const muted = useStore(playbackStore, (s) => s.muted);
  const shuffle = useStore(playbackStore, (s) => s.shuffle);
  const repeat = useStore(playbackStore, (s) => s.repeat);
  const speed = useStore(playbackStore, (s) => s.speed);
  const position = useStore(positionStore, (s) => s.positionSecs);
  const duration = useStore(positionStore, (s) => s.durationSecs);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [lyricsState, setLyricsState] = useState<"idle" | "loading" | "ready" | "missing">("idle");

  const playing = status === "playing" || status === "buffering";
  const colors = track ? trackColors(track) : (["#8b5cf6", "#7c3aed"] as const);

  // Load lyrics per track (Phase 7 wires LRCLIB in Rust; the lookup model
  // ships now and is driven purely by position).
  useEffect(() => {
    let cancelled = false;
    if (!track) return;
    setLyricsState("loading");
    setLyrics(null);
    void api
      .getLyrics(track.id)
      .then((result) => {
        if (cancelled) return;
        if (result && result.lines.length > 0) {
          setLyrics(result);
          setLyricsState("ready");
        } else {
          setLyricsState("missing");
        }
      })
      .catch(() => !cancelled && setLyricsState("missing"));
    return () => {
      cancelled = true;
    };
  }, [track?.id]);

  const activeLine = useMemo(
    () => (lyrics ? activeLineIndex(lyrics, position) : null),
    [lyrics, position],
  );

  return (
    <div className="now-playing">
      <div className="np-bg" style={{ ["--np-a" as string]: colors[0], ["--np-b" as string]: colors[1] }} />
      <div className="np-top">
        <span className="hint">Now playing</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            className="icon-button"
            title="Playback speed"
            onClick={() => {
              const idx = SPEEDS.indexOf(speed);
              void api.setSpeed(SPEEDS[(idx + 1) % SPEEDS.length] ?? 1);
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 700 }}>{speed}×</span>
          </button>
          <button className="icon-button" title="Close (Esc)" onClick={() => openNowPlaying(false)}>
            <Icon name="chevron-down" size={20} />
          </button>
        </div>
      </div>

      <div className="np-center">
        <div className="np-art-wrap">
          <Artwork track={track} size={420} rounded={22} className="np-art" />
          <div className="np-info">
            <h1 className="np-title">{track ? track.title : "Nothing playing"}</h1>
            <p className="np-artist">
              {track ? artistLine(track) : "Pick a song to begin"}
              {track?.album ? ` — ${track.album.title}` : ""}
            </p>
            <div className="np-badges">
              <span className="badge">{status}</span>
              {speed !== 1 && <span className="badge">{speed}× speed</span>}
              {status === "buffering" && <span className="badge">buffering</span>}
            </div>
          </div>
        </div>

        <div className="np-lyrics">
          {lyricsState === "loading" && (
            <div className="lyrics-state">
              <div className="spinner" />
              <span>Looking for lyrics…</span>
            </div>
          )}
          {lyricsState === "missing" && (
            <div className="lyrics-state">
              <Icon name="lyrics" size={26} />
              <span>
                No lyrics found for this track.
                <br />
                <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
                  Synced lyrics (LRCLIB) arrive in Phase 7 — and they follow the
                  authoritative playback clock, not a frontend timer.
                </span>
              </span>
            </div>
          )}
          {lyricsState === "ready" && lyrics && (
            <LyricList lyrics={lyrics} activeIndex={activeLine} position={position} />
          )}
        </div>
      </div>

      <div className="np-bottom">
        <div className="np-seek">
          <span className="time">{formatTime(position)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, duration ?? track?.durationSecs ?? 1)}
            step={0.5}
            value={Math.min(position, duration ?? position)}
            onChange={(e) => void api.seekTo(Number(e.target.value))}
          />
          <span className="time" style={{ textAlign: "right" }}>
            {formatTime(duration ?? track?.durationSecs)}
          </span>
        </div>

        <div className="np-controls">
          <button
            className={`icon-button${shuffle ? " toggled" : ""}`}
            title="Shuffle"
            onClick={() => void api.setShuffle(!shuffle)}
          >
            <Icon name="shuffle" size={18} />
          </button>
          <button className="icon-button" title="Previous" onClick={() => void api.previous()}>
            <Icon name="previous" size={24} filled />
          </button>
          <button className="play-button" title="Play/Pause" onClick={() => void api.togglePlay()}>
            <Icon name={playing ? "pause" : "play"} size={24} filled />
          </button>
          <button className="icon-button" title="Next" onClick={() => void api.next()}>
            <Icon name="next" size={24} filled />
          </button>
          <button
            className={`icon-button${repeat !== "off" ? " toggled" : ""}`}
            title={`Repeat: ${repeat}`}
            onClick={() =>
              void api.setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off")
            }
          >
            <Icon name={repeat === "one" ? "repeat-one" : "repeat"} size={18} />
          </button>
        </div>

        <div className="np-extras">
          <button
            className={`icon-button${muted ? " accent" : ""}`}
            title="Mute"
            onClick={() => void api.toggleMute()}
          >
            <Icon name={muted ? "volume-mute" : "volume"} size={18} />
          </button>
          <div className="volume">
            <input
              type="range"
              min={0}
              max={100}
              value={muted ? 0 : volume}
              onChange={(e) => void api.setVolume(Number(e.target.value))}
            />
          </div>
          <button className="icon-button" title="Like (Phase 6)">
            <Icon name="heart" size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function LyricList({
  lyrics,
  activeIndex,
  position,
}: {
  lyrics: Lyrics;
  activeIndex: number | null;
  position: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Smooth follow-scroll: only when the active line leaves the middle band.
  useEffect(() => {
    const el = activeRef.current;
    const box = containerRef.current;
    if (!el || !box) return;
    const boxRect = box.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const target = box.scrollTop + (elRect.top - boxRect.top) - boxRect.height / 2 + elRect.height / 2;
    if (typeof box.scrollTo === "function") {
      box.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    } else {
      box.scrollTop = Math.max(0, target); // older engines / test envs
    }
  }, [activeIndex]);

  return (
    <div ref={containerRef} style={{ overflowY: "auto", maxHeight: "58vh", paddingRight: 8 }}>
      {lyrics.lines.map((line, i) => (
        <div
          key={i}
          ref={i === activeIndex ? activeRef : null}
          className={`lyric-line${i === activeIndex ? " active" : ""}${
            activeIndex != null && i < activeIndex ? " past" : ""
          }`}
          onClick={() => {
            if (line.timeMs != null) void api.seekTo(line.timeMs / 1000);
          }}
          title={line.timeMs != null ? `Seek to ${formatTime(line.timeMs / 1000)}` : undefined}
        >
          {line.text || "·"}
        </div>
      ))}
      <div style={{ height: 120 }} />
      <span style={{ display: "none" }}>{position.toFixed(2)}</span>
    </div>
  );
}
