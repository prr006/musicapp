/**
 * Real adapter: talks to the Rust backend over Tauri IPC.
 * This is the ONLY file in the frontend that touches @tauri-apps/api.
 */

import type { EventName, EventPayloads, IpcBridge, CommandName } from "./contract";
import type { CommandArgs, CommandResult } from "./contract";

type TauriApi = typeof import("@tauri-apps/api/core");
type TauriEvent = typeof import("@tauri-apps/api/event");

let api: TauriApi | null = null;
let evt: TauriEvent | null = null;

export function tauriAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function ensure() {
  if (!api) api = await import("@tauri-apps/api/core");
  if (!evt) evt = await import("@tauri-apps/api/event");
}

export const tauriBridge: IpcBridge = {
  kind: "tauri",
  async invoke<K extends CommandName>(
    cmd: K,
    ...args: K extends keyof CommandArgs ? [CommandArgs[K]] : []
  ): Promise<K extends keyof CommandResult ? CommandResult[K] : void> {
    await ensure();
    return api!.invoke(cmd, (args[0] ?? undefined) as Record<string, unknown> | undefined) as never;
  },
  on<E extends EventName>(event: E, handler: (payload: EventPayloads[E]) => void): () => void {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void ensure().then(() => {
      // Tauri v2 delivers the payload wrapped: { event, id, payload }
      void evt!.listen<EventPayloads[E]>(event, (e) => handler(e.payload)).then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  },
};
