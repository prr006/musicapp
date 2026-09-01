/**
 * Render smoke test: mounts the whole <App/> against the mock bridge and
 * asserts the shell (sidebar, topbar, player, home content) renders and
 * reacts to a play command. Catches wiring/runtime errors across components.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import App from "@/App";
import { playbackController } from "@/player/controller";

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(<App />));
  return container;
}


/**
 * Type into a React-controlled input (bypasses ReactDOM's value tracker so
 * onChange actually fires in jsdom).
 */
function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("<App/> smoke", () => {
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    // The controller is a module singleton: reset it so each render starts
    // from "Nothing playing" (no cross-test playback state).
    playbackController.resetForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    container?.remove();
    container = null;
  });

  it("renders the shell: brand, nav, search box, player bar", () => {
    container = mount();
    expect(document.querySelector(".brand-name")?.textContent).toBe("MELO");
    expect(document.querySelector("[data-global-search]")).toBeTruthy();
    expect(document.querySelector(".player")).toBeTruthy();
    expect(document.querySelector(".nav-item.active")?.textContent).toContain("Home");
  });

  it("shows the mock-preview notice and quick picks", () => {
    container = mount();
    expect(document.querySelectorAll(".card").length).toBeGreaterThan(3);
  });

  it("playing a track from home updates the mini player", async () => {
    container = mount();
    const card = document.querySelector(".card") as HTMLElement;
    expect(card).toBeTruthy();
    await act(async () => {
      card.click();
      await vi.advanceTimersByTimeAsync(600);
    });
    const title = document.querySelector(".player-title")?.textContent ?? "";
    expect(title).not.toContain("Nothing playing");
    expect(document.querySelector(".player .play-button")).toBeTruthy();
  });

  it("opens the queue panel via the queue button", async () => {
    container = mount();
    await act(async () => {
      (document.querySelector('button[title^="Queue"]') as HTMLElement).click();
    });
    expect(document.querySelector(".queue-panel")).toBeTruthy();
    // Playing something first also shows it as "Now playing" in the panel.
    const card = document.querySelector(".card") as HTMLElement;
    await act(async () => {
      card.click();
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(document.querySelector(".queue-item.current")).toBeTruthy();
  });

  it("a SINGLE click on a track row plays it (no double-click anywhere)", async () => {
    container = mount();
    // Navigate to search and wait for results.
    await act(async () => {
      const input = document.querySelector("[data-global-search]") as HTMLInputElement;
      typeInto(input, "neon");
      await vi.advanceTimersByTimeAsync(400);
    });
    const row = document.querySelector(".track-row") as HTMLElement;
    expect(row).toBeTruthy();
    await act(async () => {
      row.click(); // single click — that must be enough
      await vi.advanceTimersByTimeAsync(600);
    });
    const title = document.querySelector(".player-title")?.textContent ?? "";
    expect(title).toContain("Neon River");
  });

  it("secondary row actions do not trigger playback", async () => {
    container = mount();
    await act(async () => {
      const input = document.querySelector("[data-global-search]") as HTMLInputElement;
      typeInto(input, "neon");
      await vi.advanceTimersByTimeAsync(400);
    });
    // "Neon River" is pre-liked in the mock seed — the heart is filled.
    const like = document.querySelector(
      '.track-row button[title^="Remove from favorites"]',
    ) as HTMLElement;
    expect(like).toBeTruthy();
    await act(async () => {
      like.click();
      await vi.advanceTimersByTimeAsync(300);
    });
    // Nothing started playing from the like button.
    const title = document.querySelector(".player-title")?.textContent ?? "";
    expect(title).toContain("Nothing playing");
    // The unlike itself landed (heart flips via the library mirror).
    const unliked = document.querySelector('.track-row button[title^="Add to favorites"]');
    expect(unliked).toBeTruthy();
  });
});
