//go:build !windows

package main

// MELO's tray integration is Windows-only; other platforms get a no-op instead
// of a control that pretends to work.
type tray struct{}

func startTray(func(action string), func(), func()) *tray { return nil }
func (t *tray) SetTooltip(string)                         {}
func (t *tray) Notify(string, string)                     {}
func (t *tray) Stop()                                     {}
func traySupport() string                                 { return "unsupported" }
