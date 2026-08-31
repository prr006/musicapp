/**
 * Home (spec §6): greeting, jump-back-in, recommendations from listening
 * history, recently played, favorites, and recent searches. Everything is
 * derived from the library mirror — no sample data in the real app.
 */

import { useMemo } from "react";

import * as api from "@/app/api";
import { Artwork } from "@/components/Artwork";
import { Icon } from "@/components/Icon";
import { useLibrary } from "@/app/stores/library";
import { queueStore, playbackStore } from "@/app/stores/playback";
import { navigate, setSearchQuery } from "@/app/stores/ui";
import { recommendedTracks } from "@/lib/collection";
import { useStore } from "@/app/store";
import { artistLine, type Track } from "@/types/domain";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up?";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function HomeView() {
  const library = useLibrary();
  const current = useStore(queueStore, (s) => s.current);
  const status = useStore(playbackStore, (s) => s.status);

  const recent = useMemo(() => {
    if (!library) return [];
    const seen = new Set<string>();
    const out: Track[] = [];
    for (const entry of library.history) {
      if (seen.has(entry.track.id)) continue;
      seen.add(entry.track.id);
      out.push(entry.track);
      if (out.length >= 8) break;
    }
    return out;
  }, [library]);

  const picks = useMemo(() => recommendedTracks(library, 8), [library]);
  const liked = library?.liked ?? [];
  const searches = library?.searchHistory ?? [];

  return (
    <div>
      <div className="hero">
        <h1>{greeting()}</h1>
        <p>Local-first listening. Rust owns playback; this page just listens.</p>
      </div>

      {current && (
        <Section title="Jump back in" sub={`Paused on ${artistLine(current.track)} — resumes exactly where you left off`}>
          <div className="jump-card">
            <Artwork track={current.track} size={72} rounded={10} />
            <div style={{ minWidth: 0 }}>
              <div className="card-title">{current.track.title}</div>
              <div className="card-sub">
                {artistLine(current.track)} · {status}
              </div>
            </div>
            <button className="button" onClick={() => void api.play()}>
              <Icon name="play" size={14} filled /> Resume
            </button>
          </div>
        </Section>
      )}

      {picks.length > 0 && (
        <Section title="More like what you play" sub="From your listening history">
          <div className="grid">
            {picks.map((track) => (
              <TrackCard key={track.id} track={track} />
            ))}
          </div>
        </Section>
      )}

      {recent.length > 0 && (
        <Section title="Recently played" sub="What you actually heard, not what we guess you like">
          <div className="grid">
            {recent.map((track) => (
              <TrackCard key={track.id} track={track} />
            ))}
          </div>
        </Section>
      )}

      {liked.length > 0 && (
        <Section title="Liked songs" sub={`${liked.length} favorite${liked.length === 1 ? "" : "s"}`}>
          <div className="grid">
            {liked.slice(0, 8).map((track) => (
              <TrackCard key={track.id} track={track} />
            ))}
          </div>
          <button className="button ghost" onClick={() => navigate("liked")}>
            See all
          </button>
        </Section>
      )}

      {searches.length > 0 && (
        <Section title="Recent searches" sub="Pick up a search again">
          <div className="chip-row">
            {searches.slice(0, 8).map((q) => (
              <button key={q} className="chip" onClick={() => setSearchQuery(q)}>
                <Icon name="search" size={12} /> {q}
              </button>
            ))}
          </div>
        </Section>
      )}

      {(!library || (recent.length === 0 && liked.length === 0 && searches.length === 0 && !current)) && (
        <div className="state-block">
          <div className="big">♪</div>
          <h3>Nothing here yet</h3>
          <p>
            Search for something (<kbd>Ctrl K</kbd>) and press play — MELO
            keeps history, favorites, and recommendations from there.
          </p>
        </div>
      )}
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="home-section">
      <h3>{title}</h3>
      {sub && <p className="section-sub">{sub}</p>}
      {children}
    </section>
  );
}

function TrackCard({ track }: { track: Track }) {
  return (
    <button
      className="card"
      onClick={() => void api.playNow(track)}
      title={`Play “${track.title}”`}
    >
      <Artwork track={track} size={148} rounded={12} />
      <div className="card-title">{track.title}</div>
      <div className="card-sub">{artistLine(track)}</div>
    </button>
  );
}
