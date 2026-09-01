/**
 * Event wiring: subscribes to library + runtime events exactly once and
 * routes them into stores. ALL engine events (state/position/end) flow
 * through the playback controller (queue decisions + clock anchoring) —
 * there is exactly one handler chain per engine event.
 */

import { getBridge } from "@/app/ipc";
import { Events } from "@/app/ipc/contract";
import { onLibraryUpdated } from "@/app/stores/library";
import { pushToast, setRuntimeStatus } from "@/app/stores/ui";
import { autoplayService } from "@/player/autoplay";

export interface Wiring {
  dispose(): void;
}

export function wireEvents(): Wiring {
  const bridge = getBridge();
  const offs: Array<() => void> = [];

  offs.push(
    bridge.on(Events.libraryUpdated, (data) => {
      onLibraryUpdated(data);
      // Local autoplay pool + play-count weights (most-played artists first).
      autoplayService.setPool(Object.values(data?.tracks ?? {}));
      const counts: Record<string, number> = {};
      for (const entry of data?.history ?? []) {
        const artistId = entry.track?.artists?.[0]?.id ?? entry.track?.id;
        if (artistId) counts[artistId] = (counts[artistId] ?? 0) + 1;
      }
      autoplayService.setPlayCounts(counts);
    }),
  );

  // Engine `runtime://status` is consumed by the controller too (engine-ready
  // resync); this subscription surfaces the first-run/repair state in the UI.
  offs.push(
    bridge.on(Events.runtimeStatus, (s) => {
      setRuntimeStatus(s.phase, s.message);
      if (s.phase === "installing") pushToast(s.message, "info");
    }),
  );

  return {
    dispose() {
      for (const off of offs) off();
    },
  };
}
