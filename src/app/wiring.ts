/**
 * Event wiring: subscribes to every backend event exactly once and routes
 * payloads into stores. Owned by useAppBridge; returns a teardown for tests.
 */

import { getBridge } from "@/app/ipc";
import { onPlaybackState, onPosition, playbackStore } from "@/app/stores/playback";
import { onQueueView } from "@/app/stores/playback";
import { onLibraryUpdated } from "@/app/stores/library";
import { onPositionEvent } from "@/app/stores/clock";
import { pushToast } from "@/app/stores/ui";

export interface Wiring {
  dispose(): void;
}

export function wireEvents(): Wiring {
  const bridge = getBridge();
  const offs: Array<() => void> = [];

  offs.push(bridge.on("playback://state", onPlaybackState));

  offs.push(
    bridge.on("playback://position", (p) => {
      onPosition(p);
      onPositionEvent({
        positionSecs: p.positionSecs,
        durationSecs: p.durationSecs,
        speed: p.speed,
        playing: playbackStore.get().status === "playing",
      });
    }),
  );

  offs.push(bridge.on("queue://view", onQueueView));
  offs.push(bridge.on("library://updated", onLibraryUpdated));

  offs.push(
    bridge.on("engine://status", (status) => {
      if (status.health === "dead") {
        pushToast(status.message || "Playback engine stopped", "error");
      } else if (status.health === "restarting") {
        pushToast(status.message || "Restarting playback engine…", "info");
      }
    }),
  );

  return {
    dispose() {
      for (const off of offs) off();
    },
  };
}
