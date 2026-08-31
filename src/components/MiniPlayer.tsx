/**
 * Persistent bottom player (spec §10). Renders backend state only; every
 * interaction is a command. Position comes from the throttled position store.
 */

import * as api from "@/app/api";
import { Artwork } from "@/components/Artwork";
import { Icon } from "@/components/Icon";
import { useStore } from "@/app/store";
import { openNowPlaying, toggleQueue, uiStore } from "@/app/stores/ui";
import { playbackStore, positionStore, queueStore } from "@/app/stores/playback";
import { artistLine } from "@/types/domain";
import { formatTime } from "@/lib/format";

export function MiniPlayer() {
  const status = useStore(playbackStore, (s) => s.status);
  const track = useStore(playbackStore, (s) => s.currentTrack);
  const volume = useStore(playbackStore, (s) => s.volume);
  const muted = useStore(playbackStore, (s) => s.muted);
  const shuffle = useStore(playbackStore, (s) => s.shuffle);
  const repeat = useStore(playbackStore, (s) => s.repeat);
  const error = useStore(playbackStore, (s) => s.error);
  const position = useStore(positionStore, (s) => s.positionSecs);
  const duration = useStore(positionStore, (s) => s.durationSecs);
  const queueOpen = useStore(uiStore, (s) => s.queueOpen);
  const upcomingCount = useStore(queueStore, (s) => s.upcoming.length);

  const playing = status === "playing" || status === "buffering";
  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <footer className="player">
      {/* thin full-width progress rail */}
      <div
        className="player-progress"
        title="Seek"
        onClick={(e) => {
          if (!duration) return;
          const rect = e.currentTarget.getBoundingClientRect();
          void api.seekTo(((e.clientX - rect.left) / rect.width) * duration);
        }}
      >
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>

      <div
        className="player-left"
        title={track ? "Open Now Playing" : ""}
        onClick={() => track && openNowPlaying(true)}
      >
        <Artwork track={track} size={54} rounded={10} />
        {track ? (
          <div className="player-track-info">
            <span className="player-title">{track.title}</span>
            <span className="player-artist">{artistLine(track)}</span>
            {error && (
              <span className="player-artist" style={{ color: "var(--danger)" }}>
                {error}
              </span>
            )}
          </div>
        ) : (
          <div className="player-track-info">
            <span className="player-title" style={{ color: "var(--text-faint)" }}>
              Nothing playing
            </span>
            <span className="player-artist">Search or pick something to start</span>
          </div>
        )}
      </div>

      <div className="player-center">
        <div className="transport">
          <button
            className={`icon-button${shuffle ? " toggled" : ""}`}
            title="Shuffle (S)"
            onClick={() => void api.setShuffle(!shuffle)}
          >
            <Icon name="shuffle" size={16} />
          </button>
          <button className="icon-button" title="Previous (Ctrl+←)" onClick={() => void api.previous()}>
            <Icon name="previous" size={18} filled />
          </button>
          <button
            className="play-button"
            title="Play/Pause (Space)"
            onClick={() => void api.togglePlay()}
          >
            <Icon name={playing ? "pause" : "play"} size={20} filled />
          </button>
          <button className="icon-button" title="Next (Ctrl+→)" onClick={() => void api.next()}>
            <Icon name="next" size={18} filled />
          </button>
          <button
            className={`icon-button${repeat !== "off" ? " toggled" : ""}`}
            title={`Repeat: ${repeat} (R)`}
            onClick={() => void api.setRepeat(repeat === "off" ? "all" : repeat === "all" ? "one" : "off")}
          >
            <Icon name={repeat === "one" ? "repeat-one" : "repeat"} size={16} />
          </button>
        </div>
        <div className="player-times">
          <span>{formatTime(position)}</span>
          <div
            className="bar"
            title="Seek"
            onClick={(e) => {
              if (!duration) return;
              const rect = e.currentTarget.getBoundingClientRect();
              void api.seekTo(((e.clientX - rect.left) / rect.width) * duration);
            }}
          >
            <div className="fill" style={{ width: `${pct}%` }} />
          </div>
          <span>{formatTime(duration ?? track?.durationSecs)}</span>
        </div>
      </div>

      <div className="player-right">
        <button
          className={`icon-button${muted ? " accent" : ""}`}
          title="Mute (M)"
          onClick={() => void api.toggleMute()}
        >
          <Icon name={muted ? "volume-mute" : "volume"} size={17} />
        </button>
        <div className="volume">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={muted ? 0 : volume}
            onChange={(e) => void api.setVolume(Number(e.target.value))}
            title="Volume (↑/↓)"
          />
        </div>
        <button
          className={`icon-button${queueOpen ? " accent" : ""}`}
          title={`Queue (Q) — ${upcomingCount} upcoming`}
          onClick={toggleQueue}
        >
          <Icon name="queue" size={17} />
        </button>
        <button
          className="icon-button"
          title="Expand (L)"
          onClick={() => openNowPlaying(true)}
          disabled={!track}
        >
          <Icon name="expand" size={16} />
        </button>
      </div>
    </footer>
  );
}
