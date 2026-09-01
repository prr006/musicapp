//go:build windows

package main

import (
	"log"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows media-key support via RegisterHotKey on a dedicated OS thread with
// its own message loop. This is the smallest reliable mechanism that works
// while the app is in the background, and it needs no extra dependencies.
type mediaKeyListener struct {
	threadID uint32
	stopped  chan struct{}
}

const (
	vkMediaNextTrack = 0xB0
	vkMediaPrevTrack = 0xB1
	vkMediaStop      = 0xB2
	vkMediaPlayPause = 0xB3
	wmHotkey         = 0x0312
	wmQuit           = 0x0012
)

var (
	user32              = windows.NewLazySystemDLL("user32.dll")
	procRegisterHotKey  = user32.NewProc("RegisterHotKey")
	procUnregisterHotKe = user32.NewProc("UnregisterHotKey")
	procGetMessageW     = user32.NewProc("GetMessageW")
	procPostThreadMsgW  = user32.NewProc("PostThreadMessageW")
	kernel32            = windows.NewLazySystemDLL("kernel32.dll")
	procGetCurrentThrID = kernel32.NewProc("GetCurrentThreadId")
)

type msg struct {
	HWND    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
}

var hotkeys = map[int]string{
	1: "playpause",
	2: "next",
	3: "previous",
	4: "stop",
}

var hotkeyVK = map[int]int{
	1: vkMediaPlayPause,
	2: vkMediaNextTrack,
	3: vkMediaPrevTrack,
	4: vkMediaStop,
}

func startMediaKeys(emit func(action string)) *mediaKeyListener {
	l := &mediaKeyListener{stopped: make(chan struct{})}
	ready := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(l.stopped)

		tid, _, _ := procGetCurrentThrID.Call()
		l.threadID = uint32(tid)
		registered := make([]int, 0, len(hotkeyVK))
		for id, vk := range hotkeyVK {
			r, _, _ := procRegisterHotKey.Call(0, uintptr(id), 0, uintptr(vk))
			if r != 0 {
				registered = append(registered, id)
			}
		}
		close(ready)
		if len(registered) == 0 {
			log.Println("melo: media keys unavailable (already claimed by another app)")
			return
		}
		defer func() {
			for _, id := range registered {
				procUnregisterHotKe.Call(0, uintptr(id))
			}
		}()

		var m msg
		for {
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			if int32(r) <= 0 {
				return
			}
			if m.Message == wmHotkey {
				if action, ok := hotkeys[int(m.WParam)]; ok {
					emit(action)
				}
			}
		}
	}()
	<-ready
	return l
}

func (l *mediaKeyListener) Stop() {
	if l == nil || l.threadID == 0 {
		return
	}
	procPostThreadMsgW.Call(uintptr(l.threadID), wmQuit, 0, 0)
	<-l.stopped
}

func mediaKeySupport() string { return "windows-hotkeys" }
