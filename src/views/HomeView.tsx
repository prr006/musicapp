/**
 * Home (spec §6). Phase 1: sample catalog in the browser preview, honest
 * phase-status states in the real app. Recently played will come from real
 * history in Phase 9; recommendations from listening history in Phase 9+.
 */

import { useMemo } from "react";

import * as api from "@/app/api";
import { Artwork } from "@/components/Artwork";
import { Icon, type IconName } from "@/components/Icon";
import { getBridge } from "@/app/ipc";
import { SAMPLE_TRACKS } from "@/app/ipc/sampleData";
import { useStore } from "@/app/store";
import { queueStore } from "@/app/stores/playback";
import { artistLine, type Track } from "@/types/domain";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up?";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function HomeView() {
  const isMock = getBridge().kind === "mock";
  const history = useStore(queueStore, (s) => s.history);

  const quickPicks = useMemo(() => SAMPLE_TRACKS.slice(0, 6), []);
  const recentlyPlayed = useMemo(() => {
    const seen = new Set<string>();
    const tracks: Track[] = [];
    for (const item of history) {
      if (seen.has(item.track.id)) continue;
      seen.add(item.track.id);
      tracks.push(item.track);
      if (tracks.length >= 6) break;
    }
    return tracks;
  }, [history]);

  return (
    <div>
      <div className="hero">
        <h1>{greeting()}</h1>
        <p>Local-first listening. Rust owns the state; the UI just listens.</p>
      </div>

      {isMock ? (
        <>
          <Section title="Quick picks" sub="From the sample catalog">
            <div className="grid">
              {quickPicks.map((track) => (
                <TrackCard key={track.id} track={track} />
              ))}
            </div>
          </Section>

          {recentlyPlayed.length > 0 && (
            <Section title="Recently played" sub="From your queue history">
              <div className="grid">
                {recentlyPlayed.map((track) => (
                  <TrackCard key={track.id} track={track} />
                ))}
              </div>
            </Section>
          )}

          <Section title="Full sample album" sub="Start a sequence — auto-next works">
            <div style={{ maxWidth: 640 }}>
              <AlbumStarter />
            </div>
          </Section>
        </>
      ) : (
        <div className="state-block">
          <div className="big">♪</div>
          <h3>The library wakes up in Phase 5</h3>
          <p>
            YouTube search + streaming (yt-dlp) lands next. The playback engine,
            queue, and state machine behind it are already live — check the
            architecture notes below.
          </p>
        </div>
      )}

      <Section title="How MELO is built" sub="Playback reliability before polish (spec §37)">
        <div className="arch-cards">
          <ArchCard icon="note" title="Rust owns playback state">
            One state machine in Rust decides everything; React renders events.
            There is a single authoritative playback clock.
          </ArchCard>
          <ArchCard icon="next" title="mpv under supervision">
            mpv runs as a supervised child process over JSON IPC. End-of-file
            auto-advances the queue in Rust — no frontend timers.
          </ArchCard>
          <ArchCard icon="queue" title="Queue as a state machine">
            Play order, history, shuffle and repeat are invariants, verified by
            40+ unit tests across Rust and the browser mock.
          </ArchCard>
          <ArchCard icon="lyrics" title="Lyrics follow the clock">
            The highlighted line is a pure function of the engine-reported
            position — stable across seeks, pauses, speed changes.
          </ArchCard>
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="section">
      <div className="section-head">
        <span className="section-title">{title}</span>
        {sub && <span className="section-sub">{sub}</span>}
      </div>
      {children}
    </div>
  );
}

function ArchCard({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <div className="arch-card">
      <h4>
        <Icon name={icon} size={15} />
        {title}
      </h4>
      <p>{children}</p>
    </div>
  );
}

function TrackCard({ track }: { track: Track }) {
  return (
    <button className="card" onDoubleClick={() => void api.playNow(track)} onClick={() => void api.playNow(track)}>
      <div className="card-art">
        <Artwork track={track} size={148} rounded={12} />
        <span className="card-play">
          <Icon name="play" size={17} filled />
        </span>
      </div>
      <div>
        <div className="card-title">{track.title}</div>
        <div className="card-sub">{artistLine(track)}</div>
      </div>
    </button>
  );
}

function AlbumStarter() {
  const album = SAMPLE_TRACKS.slice(0, 2);
  const rest = SAMPLE_TRACKS.slice(2);
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <button className="button" onClick={() => void api.startSequence(album, false)}>
        Play “Afterglow” in order
      </button>
      <button className="button ghost" onClick={() => void api.startSequence(rest, true)}>
        Shuffle the rest
      </button>
    </div>
  );
}
