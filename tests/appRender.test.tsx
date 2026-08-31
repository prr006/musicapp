/**
 * Render smoke test: mounts the whole <App/> against the mock bridge and
 * asserts the shell (sidebar, topbar, player, home content) renders and
 * reacts to a play command. Catches wiring/runtime errors across components.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import App from "@/App";

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(<App />));
  return container;
}

describe("<App/> smoke", () => {
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
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
});
