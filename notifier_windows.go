//go:build windows

package main

// Windows notifications are tray balloon messages: they ride on the tray
// icon's hidden window. The notifier delegates to whichever tray is currently
// running; with the tray disabled there is no balloon surface, so the call is
// simply skipped — never fabricated.
type trayNotifier struct {
	tray func() *tray
}

func newNotifier(trayFn func() *tray) notifier { return trayNotifier{tray: trayFn} }

func (n trayNotifier) Notify(title, body string) {
	if t := n.tray(); t != nil {
		t.Notify(title, body)
	}
}

func notificationSupport() string { return "windows-balloon" }
