//go:build !windows

package main

// Media keys are only wired up on Windows, which is MELO's target platform.
// Other platforms get a no-op rather than a control that pretends to work.
type mediaKeyListener struct{}

func startMediaKeys(func(action string)) *mediaKeyListener { return nil }
func (l *mediaKeyListener) Stop()                          {}
func mediaKeySupport() string                              { return "unsupported" }
