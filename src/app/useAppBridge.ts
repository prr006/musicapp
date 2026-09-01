/**
 * Wires backend events → stores + initial sync. Mounted once in <App/>.
 */

import { useEffect } from "react";

import * as api from "@/app/api";
import { tauriAvailable } from "@/app/ipc";
import { wireEvents } from "@/app/wiring";
import { applySettings, pushToast, uiStore } from "@/app/stores/ui";
import type { Settings } from "@/types/domain";
import { onLibraryUpdated } from "@/app/stores/library";
import { playbackController } from "@/player/controller";
import { autoplayService } from "@/player/autoplay";

export function useAppBridge(): void {
  useEffect(() => {
    const wiring = wireEvents();
    // Engine events + queue bootstrap (session restore, never autoplay).
    const disposeController = playbackController.wire();

    void api.getLibrary().then(onLibraryUpdated).catch(noop);
    void api
      .getSettings()
      .then((raw) => raw as Settings)
      .then((settings) => {
        applySettings(settings);
        autoplayService.setEnabled(settings.autoplaySimilar);
      })
      .catch(noop);

    if (!tauriAvailable()) {
      pushToast("Browser preview — mock native boundary (no real audio)", "info");
    }

    const goOnline = () => {
      uiStore.set({ online: true });
      pushToast("Back online", "success");
    };
    const goOffline = () => {
      uiStore.set({ online: false });
      pushToast("You're offline — playback of loaded media continues", "info");
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    const flush = () => playbackController.flushSession();
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);

    return () => {
      wiring.dispose();
      disposeController();
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, []);
}

function noop(): void {}
