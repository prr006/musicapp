//go:build !windows && !linux

package main

// macOS notifications (osascript / UserNotifications) are deliberately NOT
// implemented: MELO has not been built or tested on macOS, and a no-op keeps
// both the build and the settings UI honest instead of pretending.
type noopNotifier struct{}

func newNotifier(func() *tray) notifier { return noopNotifier{} }

func (noopNotifier) Notify(string, string) {}

func notificationSupport() string { return "unsupported" }
