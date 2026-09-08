package main

// notifier raises track-change notifications through whatever mechanism the
// platform actually offers. Implementations live in notifier_windows.go,
// notifier_linux.go and notifier_other.go; application code never branches on
// the OS and always has a usable notifier (a no-op on platforms without a
// mechanism, rather than one that pretends to work).
//
// The tray tooltip (SetNowPlaying's other half) stays a tray concern: it only
// exists where a tray exists. Notifications are decoupled so a platform can
// have one without the other.
type notifier interface {
	Notify(title, body string)
}
