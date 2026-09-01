/**
 * Event wiring: subscribes to engine + runtime + library events exactly once
 * and routes them into stores. Engine events flow through the controller
 * (queue decisions) and the clock (position interpolation with resync).
 */

import { getBridge } from "@/app/ipc";
import { Events } from "@/app/ipc/contract";
import { onLibraryUpdated } from "@/app/stores/library";
import { onPositionEvent } from "@/app/stores/clock";
import { pushToast } from "@/app/stores/ui";
import { positionStore, playbackStore } from "@/app/stores/playback";

export interface Wiring {
  dispose(): void;
}

export function wireEvents(): Wiring {
  const bridge = getBridge();
  const offs: Array<() => void> = [];

  // Engine state: authoritative snapshot. Every state change re-anchors the
  // interpolated clock (pause/resume/seek/buffering/track change all arrive
  // here), so the UI can never drift from the engine.
  offs.push(
    bridge.on(Events.playerState, (s) => {
      onPositionEvent({
        positionSecs: s.positionSecs,
        durationSecs: s.durationSecs,
        speed: s.speed,
        playing: s.status === "playing",
      });
      positionStore.set({ positionSecs: s.positionSecs, durationSecs: s.durationSecs });
    }),
  );

  // Position samples (the truth between state changes). Interpolation uses
  // the engine's own speed + playing state, never a frontend guess.
  offs.push(
    bridge.on(Events.playerPosition, (p) => {
      const snap = playbackStore.get();
      onPositionEvent({
        positionSecs: p.positionSecs,
        durationSecs: p.durationSecs,
        speed: snap.speed,
        playing: snap.status === "playing",
      });
      positionStore.set({ positionSecs: p.positionSecs, durationSecs: p.durationSecs });
    }),
  );

  offs.push(bridge.on(Events.libraryUpdated, onLibraryUpdated));

  offs.push(
    bridge.on(Events.runtimeStatus, (s) => {
      if (s.phase === "error") pushToast(s.message, "error");
      else if (s.phase === "installing") pushToast(s.message, "info");
    }),
  );

  return {
    dispose() {
      for (const off of offs) off();
    },
  };
}
