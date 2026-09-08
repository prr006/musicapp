package main

import (
	"path/filepath"
	"runtime"
	"testing"
)

// Cross-platform regression tests for the OS abstraction surface. The
// assertions are deliberately platform-neutral — they must pass unchanged on
// Windows, Linux and (once tested) macOS.

// TestDataDirHonorsOverride: MELO_DATA_DIR wins everywhere, so support bundles
// and CI can relocate the whole data layout.
func TestDataDirHonorsOverride(t *testing.T) {
	want := filepath.Join(t.TempDir(), "melo-data")
	t.Setenv("MELO_DATA_DIR", want)
	got, err := dataDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("dataDir = %q, want %q", got, want)
	}
}

// TestDataDirUsesUserConfigDir: without an override, the data lives under the
// OS user-config directory in a consistently named "MELO" folder on every
// platform (%AppData% on Windows, XDG config on Linux, Application Support on
// macOS). One layout, no hard-coded Windows paths.
func TestDataDirUsesUserConfigDir(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("macOS UserConfigDir derives from $HOME; not exercised in CI")
	}
	t.Setenv("MELO_DATA_DIR", "")
	base := t.TempDir()
	t.Setenv("APPDATA", base)         // Windows %AppData%
	t.Setenv("XDG_CONFIG_HOME", base) // Linux/BSD config root
	got, err := dataDir()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(base, "MELO"); got != want {
		t.Fatalf("dataDir = %q, want %q", got, want)
	}
}

// TestPlatformSurfacesAreAlwaysSafe: whatever the platform, every OS
// integration can be constructed, used and stopped without panicking, and the
// support strings are non-empty so the settings UI can rely on them.
func TestPlatformSurfacesAreAlwaysSafe(t *testing.T) {
	if notificationSupport() == "" || traySupport() == "" || mediaKeySupport() == "" {
		t.Fatalf("support strings must never be empty: notifications=%q tray=%q mediaKeys=%q",
			notificationSupport(), traySupport(), mediaKeySupport())
	}

	// Media keys: start (or no-op) then stop.
	if l := startMediaKeys(func(string) {}); l != nil {
		l.Stop()
	}

	// Tray: start (or no-op), exercise its surface, then stop.
	if tr := startTray(func(string) {}, func() {}, func() {}); tr != nil {
		tr.SetTooltip("MELO")
		tr.Notify("title", "artist")
		tr.Stop()
	}

	// Notifier: usable with and without a live tray, never panics.
	newNotifier(func() *tray { return nil }).Notify("title", "artist")
}

// TestNotifierIsDecoupledFromTray is the portability contract: notifications
// must not be gated on the tray existing, because Linux (notify-send) has
// notifications without a tray icon.
func TestNotifierIsDecoupledFromTray(t *testing.T) {
	n := newNotifier(func() *tray { return nil })
	if n == nil {
		t.Fatal("newNotifier must always return a usable notifier")
	}
	// Must be safe even for empty payloads.
	n.Notify("", "")
	n.Notify("t", "b")
}

// TestDiagnosticsIncludesPlatformCapabilities guards the diagnostics contract
// the settings UI consumes: every capability field is present and non-empty.
func TestDiagnosticsIncludesPlatformCapabilities(t *testing.T) {
	d := Diagnostics{MediaKeys: mediaKeySupport(), Tray: traySupport(), Notifications: notificationSupport()}
	if d.MediaKeys == "" || d.Tray == "" || d.Notifications == "" {
		t.Fatalf("diagnostics must carry all platform capabilities: %+v", d)
	}
}
