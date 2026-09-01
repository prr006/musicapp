/**
 * Settings modal (spec §12/§25/§26 subset for Phase 1; grows per phase).
 * Writes go through set_settings and are persisted by Rust.
 */

import { useEffect, useState } from "react";

import * as api from "@/app/api";
import { Icon } from "@/components/Icon";
import { applySettings, pushToast, uiStore, useSettings } from "@/app/stores/ui";
import type { AudioQuality, CloseAction, Diagnostics, Settings, Theme } from "@/types/domain";

const ACCENTS = ["violet", "ocean", "emerald", "sunset", "amber"] as const;

export function SettingsModal() {
  const current = useSettings();
  const [draft, setDraft] = useState<Settings>(current);
  const [saving, setSaving] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  useEffect(() => setDraft(current), [current]);

  useEffect(() => {
    void api
      .getDiagnostics()
      .then(setDiagnostics)
      .catch(() => setDiagnostics(null));
  }, []);

  async function save() {
    setSaving(true);
    try {
      await api.setSettings(draft);
      applySettings(draft);
      pushToast("Settings saved", "success");
      uiStore.set({ settingsOpen: false });
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Couldn't save settings", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && uiStore.set({ settingsOpen: false })}>
      <div className="modal" role="dialog" aria-label="Settings">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2>Settings</h2>
          <button
            className="icon-button"
            onClick={() => uiStore.set({ settingsOpen: false })}
            title="Close"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="settings-group">
          <h4>Appearance</h4>
          <Row label="Theme" hint="Dark, light, or follow the system.">
            <select
              className="setting-select"
              value={draft.theme}
              onChange={(e) => setDraft({ ...draft, theme: e.target.value as Theme })}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
          </Row>
          <Row label="Accent color">
            <div style={{ display: "flex", gap: 8 }}>
              {ACCENTS.map((a) => (
                <button
                  key={a}
                  title={a}
                  onClick={() => setDraft({ ...draft, accent: a })}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    background: `var(--accent)`,
                    // accent preview via data attribute switch
                    border: draft.accent === a ? "2px solid var(--text)" : "2px solid transparent",
                  }}
                  data-accent-preview={a}
                />
              ))}
            </div>
          </Row>
          <Row label="Animations" hint="Disable for reduced motion.">
            <Switch on={draft.animations} onChange={(v) => setDraft({ ...draft, animations: v })} />
          </Row>
          <Row label="Compact mode" hint="Smaller artwork and rows.">
            <Switch on={draft.compact} onChange={(v) => setDraft({ ...draft, compact: v })} />
          </Row>
        </div>

        <div className="settings-group">
          <h4>Playback</h4>
          <Row
            label="Audio quality"
            hint="Honest labels: MELO never claims lossless unless the source provides it."
          >
            <select
              className="setting-select"
              value={draft.audioQuality}
              onChange={(e) => setDraft({ ...draft, audioQuality: e.target.value as AudioQuality })}
            >
              <option value="low">Low (saves data)</option>
              <option value="standard">Standard</option>
              <option value="high">High</option>
              <option value="highest">Highest available</option>
            </select>
          </Row>
          <Row label="Volume normalization" hint="Even loudness across tracks (not yet implemented).">
            <Switch
              on={draft.volumeNormalization}
              onChange={(v) => setDraft({ ...draft, volumeNormalization: v })}
            />
          </Row>
          <Row label="Crossfade" hint="Off by default until reliably implemented (spec §25).">
            <select
              className="setting-select"
              value={draft.crossfadeSecs}
              onChange={(e) => setDraft({ ...draft, crossfadeSecs: Number(e.target.value) })}
            >
              <option value={0}>Off</option>
              <option value={2}>2 seconds</option>
              <option value={4}>4 seconds</option>
              <option value={6}>6 seconds</option>
            </select>
          </Row>
          <Row label="Autoplay similar music" hint="When the queue runs dry.">
            <Switch
              on={draft.autoplaySimilar}
              onChange={(v) => setDraft({ ...draft, autoplaySimilar: v })}
            />
          </Row>
        </div>

        <div className="settings-group">
          <h4>Session &amp; behavior</h4>
          <Row
            label="Restore last session"
            hint="Bring back queue, position, volume — paused. Never autoplays on launch."
          >
            <Switch
              on={draft.resumeLastSession}
              onChange={(v) => setDraft({ ...draft, resumeLastSession: v })}
            />
          </Row>
          <Row label="When MELO closes" hint="Tray integration is not implemented yet.">
            <select
              className="setting-select"
              value={draft.closeAction}
              onChange={(e) =>
                setDraft({ ...draft, closeAction: e.target.value as CloseAction })
              }
            >
              <option value="quit">Quit</option>
              <option value="minimize-to-tray" disabled>
                Minimize to tray (not implemented)
              </option>
            </select>
          </Row>
          <Row label="Save listening history" hint="Powers Recently Played and recommendations.">
            <Switch
              on={draft.historyEnabled}
              onChange={(v) => setDraft({ ...draft, historyEnabled: v })}
            />
          </Row>
        </div>

        <div className="settings-group">
          <h4>Diagnostics</h4>
          {diagnostics ? (
            <div className="diag-box">
              <div>
                Engine (libmpv):{" "}
                {diagnostics.engineRunning ? (
                  <code>{diagnostics.mpvVersion ?? diagnostics.libmpvPath}</code>
                ) : (
                  <span style={{ color: "var(--danger)" }}>
                    not running —{" "}
                    {diagnostics.libmpvFound
                      ? "loaded but failed"
                      : (
                          <>
                            libmpv-2.dll missing at <code>{diagnostics.libmpvPath ?? "?"}</code>
                          </>
                        )}{" "}
                    · use Repair runtime
                  </span>
                )}
              </div>
              <div>
                yt-dlp:{" "}
                {diagnostics.ytdlpFound ? (
                  <code>{diagnostics.ytdlpPath}</code>
                ) : (
                  <span style={{ color: "var(--danger)" }}>
                    not found — YouTube search/streaming unavailable
                  </span>
                )}
              </div>
              <div>
                Runtime dir: <code>{diagnostics.runtimeDir ?? "unknown"}</code>
              </div>
              <div>
                Audio quality: <code>{diagnostics.qualityLabel}</code>
              </div>
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={repairing}
                  onClick={async () => {
                    setRepairing(true);
                    try {
                      await api.repairRuntime();
                      pushToast("Reinstalling playback runtime…", "info");
                    } catch (e) {
                      pushToast(e instanceof Error ? e.message : "Repair failed to start", "error");
                    } finally {
                      setRepairing(false);
                    }
                  }}
                >
                  {repairing ? "Repairing…" : "Repair runtime"}
                </button>
              </div>
            </div>
          ) : (
            <div className="diag-box">Diagnostics unavailable.</div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
          <button className="button ghost" onClick={() => setDraft(current)}>
            Reset
          </button>
          <button className="button" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <label>
        {label}
        {hint && <span className="hint">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`switch${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title={on ? "On" : "Off"}
    />
  );
}
