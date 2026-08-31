/**
 * Tauri IPC bridge: invokes Rust commands through the injected internals and
 * subscribes to engine events via `@tauri-apps/api/event` (needs only the
 * `core:event` permission that `core:default` provides).
 *
 * In the packaged app this is the ONLY path to the backend — the webview has
 * no direct access to mpv, yt-dlp, or the filesystem (spec §3/§33).
 */

import { listen } from "@tauri-apps/api/event";

import type { CommandName, EventName, EventPayloads, IpcBridge } from "./contract";

type InvokeRaw = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function detectInvoke(win: Window): InvokeRaw | null {
  const internals = (win as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeRaw } })
    .__TAURI_INTERNALS__;
  return internals?.invoke?.bind(internals) ?? null;
}

export function createTauriBridge(): IpcBridge {
  const invokeRaw = detectInvoke(window);
  if (!invokeRaw) {
    throw new Error(
      "MELO: Tauri internals not found. Start the app with `npm run tauri dev` or the packaged build — plain-browser mode uses the mock bridge.",
    );
  }

  const bridge: IpcBridge = {
    kind: "tauri",
    invoke: (async (cmd: CommandName, ...args: unknown[]) => {
      const arg = (args[0] ?? {}) as Record<string, unknown>;
      // JSON round-trip drops `undefined` fields serde would choke on.
      const payload = JSON.parse(JSON.stringify(arg)) as Record<string, unknown>;
      return invokeRaw(cmd, payload);
    }) as IpcBridge["invoke"],
    on: ((event: EventName, handler: (payload: never) => void) => {
      let unlisten: (() => void) | null = null;
      let stopped = false;
      void listen(event, (e) => handler(e.payload as never)).then((un) => {
        if (stopped) un();
        else unlisten = un;
      });
      return () => {
        stopped = true;
        unlisten?.();
      };
    }) as IpcBridge["on"],
  };
  return bridge;
}

export type { EventPayloads };
