//go:build linux

package main

import (
	"os/exec"
	"sync"
)

// Linux notifications use `notify-send`, the freedesktop notification
// convention's reference client, when it is on PATH. That keeps MELO
// dependency-free (no DBus bindings) and honest: without a notification
// daemon the call fails and is swallowed — the player is never affected.
type notifySendNotifier struct {
	once sync.Once
	ok   bool
}

func newNotifier(func() *tray) notifier { return &notifySendNotifier{} }

func (n *notifySendNotifier) Notify(title, body string) {
	n.once.Do(func() {
		_, err := exec.LookPath("notify-send")
		n.ok = err == nil
	})
	if !n.ok || title == "" {
		return
	}
	args := []string{"--app-name", "MELO", title}
	if body != "" {
		args = append(args, body)
	}
	// Plain argv — no shell — so titles/artists can never be interpreted as
	// syntax. Best-effort by design.
	_ = exec.Command("notify-send", args...).Run()
}

func notificationSupport() string {
	if _, err := exec.LookPath("notify-send"); err != nil {
		return "unsupported"
	}
	return "freedesktop-notify-send"
}
