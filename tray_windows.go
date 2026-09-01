//go:build windows

package main

import (
	"log"
	"os"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows tray icon and balloon notifications.
//
// Deliberately dependency-free: a hidden top-level window on its own OS thread
// owns a Shell_NotifyIcon entry. The same window handles the tray context menu
// and shows balloon notifications on track changes. If anything here fails the
// app keeps running without a tray rather than refusing to start.

const (
	wmApp          = 0x8000
	wmTrayCallback = wmApp + 1
	wmTrayNotify   = wmApp + 2
	wmDestroy      = 0x0002
	wmCommand      = 0x0111
	wmClose        = 0x0010

	wmRButtonUp     = 0x0205
	wmLButtonUp     = 0x0202
	wmLButtonDblClk = 0x0203

	nimAdd    = 0x0000
	nimModify = 0x0001
	nimDelete = 0x0002

	nifMessage = 0x0001
	nifIcon    = 0x0002
	nifTip     = 0x0004
	nifInfo    = 0x0010

	niifInfo = 0x0001

	mfString    = 0x0000
	mfSeparator = 0x0800

	tpmRightButton = 0x0002

	idiApplication = 32512
)

const (
	cmdPlayPause = 1001
	cmdNext      = 1002
	cmdPrevious  = 1003
	cmdShow      = 1004
	cmdQuit      = 1005
)

var (
	procRegisterClassExW    = user32.NewProc("RegisterClassExW")
	procCreateWindowExW     = user32.NewProc("CreateWindowExW")
	procDefWindowProcW      = user32.NewProc("DefWindowProcW")
	procDestroyWindow       = user32.NewProc("DestroyWindow")
	procTranslateMessage    = user32.NewProc("TranslateMessage")
	procDispatchMessageW    = user32.NewProc("DispatchMessageW")
	procPostMessageW        = user32.NewProc("PostMessageW")
	procLoadIconW           = user32.NewProc("LoadIconW")
	procCreatePopupMenu     = user32.NewProc("CreatePopupMenu")
	procAppendMenuW         = user32.NewProc("AppendMenuW")
	procDestroyMenu         = user32.NewProc("DestroyMenu")
	procTrackPopupMenu      = user32.NewProc("TrackPopupMenu")
	procGetCursorPos        = user32.NewProc("GetCursorPos")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procPostQuitMessage     = user32.NewProc("PostQuitMessage")

	procGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")

	shell32            = windows.NewLazySystemDLL("shell32.dll")
	procShellNotifyIco = shell32.NewProc("Shell_NotifyIconW")
	procExtractIconW   = shell32.NewProc("ExtractIconW")
)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

type notifyIconData struct {
	CbSize           uint32
	HWnd             windows.HWND
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            windows.Handle
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UVersion         uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         windows.GUID
	HBalloonIcon     windows.Handle
}

type point struct{ X, Y int32 }

// tray is the process-wide tray controller.
type tray struct {
	hwnd     windows.HWND
	icon     windows.Handle
	stopped  chan struct{}
	emit     func(action string)
	show     func()
	quit     func()
	mu       sync.Mutex
	pendingT string
	pendingB string
	closed   bool
}

func startTray(emit func(action string), show, quit func()) *tray {
	t := &tray{stopped: make(chan struct{}), emit: emit, show: show, quit: quit}
	ready := make(chan error, 1)

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(t.stopped)

		instance, _, _ := procGetModuleHandleW.Call(0)
		className, err := windows.UTF16PtrFromString("MeloTrayWindow")
		if err != nil {
			ready <- err
			return
		}
		wc := wndClassEx{
			Style:     0,
			WndProc:   windows.NewCallback(t.wndProc),
			Instance:  windows.Handle(instance),
			ClassName: className,
		}
		wc.Size = uint32(unsafe.Sizeof(wc))
		if atom, _, e := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); atom == 0 {
			ready <- e
			return
		}
		hwnd, _, e := procCreateWindowExW.Call(
			0, uintptr(unsafe.Pointer(className)), uintptr(unsafe.Pointer(className)),
			0, 0, 0, 0, 0, 0, 0, instance, 0,
		)
		if hwnd == 0 {
			ready <- e
			return
		}
		t.hwnd = windows.HWND(hwnd)
		t.icon = loadAppIcon(windows.Handle(instance))

		nid := t.baseData()
		nid.UFlags = nifMessage | nifIcon | nifTip
		nid.UCallbackMessage = wmTrayCallback
		copyUTF16(nid.SzTip[:], "MELO")
		if r, _, e := procShellNotifyIco.Call(nimAdd, uintptr(unsafe.Pointer(nid))); r == 0 {
			procDestroyWindow.Call(hwnd)
			ready <- e
			return
		}
		defer func() {
			d := t.baseData()
			procShellNotifyIco.Call(nimDelete, uintptr(unsafe.Pointer(d)))
		}()

		ready <- nil

		var m msg
		for {
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
			if int32(r) <= 0 {
				return
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
	}()

	if err := <-ready; err != nil {
		log.Printf("melo: tray icon unavailable: %v", err)
		return nil
	}
	return t
}

func (t *tray) baseData() *notifyIconData {
	nid := &notifyIconData{HWnd: t.hwnd, UID: 1, HIcon: t.icon}
	nid.CbSize = uint32(unsafe.Sizeof(*nid))
	return nid
}

func (t *tray) wndProc(hwnd windows.HWND, message uint32, wparam, lparam uintptr) uintptr {
	switch message {
	case wmTrayCallback:
		switch uint32(lparam) {
		case wmLButtonUp, wmLButtonDblClk:
			if t.show != nil {
				t.show()
			}
		case wmRButtonUp:
			t.popupMenu()
		}
		return 0
	case wmTrayNotify:
		t.flushNotification()
		return 0
	case wmCommand:
		t.command(uint32(wparam & 0xFFFF))
		return 0
	case wmClose, wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(message), wparam, lparam)
	return r
}

func (t *tray) command(id uint32) {
	switch id {
	case cmdPlayPause:
		t.emit("playpause")
	case cmdNext:
		t.emit("next")
	case cmdPrevious:
		t.emit("previous")
	case cmdShow:
		if t.show != nil {
			t.show()
		}
	case cmdQuit:
		if t.quit != nil {
			t.quit()
		}
	}
}

func (t *tray) popupMenu() {
	menu, _, _ := procCreatePopupMenu.Call()
	if menu == 0 {
		return
	}
	defer procDestroyMenu.Call(menu)

	appendItem(menu, cmdPlayPause, "Play / Pause")
	appendItem(menu, cmdNext, "Next track")
	appendItem(menu, cmdPrevious, "Previous track")
	procAppendMenuW.Call(menu, mfSeparator, 0, 0)
	appendItem(menu, cmdShow, "Show MELO")
	appendItem(menu, cmdQuit, "Quit MELO")

	var pt point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	// Required so the menu dismisses when the user clicks elsewhere.
	procSetForegroundWindow.Call(uintptr(t.hwnd))
	procTrackPopupMenu.Call(menu, tpmRightButton, uintptr(pt.X), uintptr(pt.Y), 0, uintptr(t.hwnd), 0)
	procPostMessageW.Call(uintptr(t.hwnd), 0, 0, 0)
}

func appendItem(menu uintptr, id uint32, label string) {
	text, err := windows.UTF16PtrFromString(label)
	if err != nil {
		return
	}
	procAppendMenuW.Call(menu, mfString, uintptr(id), uintptr(unsafe.Pointer(text)))
}

// SetTooltip updates the hover text with the current track.
func (t *tray) SetTooltip(text string) {
	if t == nil || t.hwnd == 0 {
		return
	}
	nid := t.baseData()
	nid.UFlags = nifTip
	copyUTF16(nid.SzTip[:], text)
	procShellNotifyIco.Call(nimModify, uintptr(unsafe.Pointer(nid)))
}

// Notify queues a balloon notification; it is shown on the tray thread.
func (t *tray) Notify(title, body string) {
	if t == nil || t.hwnd == 0 {
		return
	}
	t.mu.Lock()
	t.pendingT, t.pendingB = title, body
	t.mu.Unlock()
	procPostMessageW.Call(uintptr(t.hwnd), wmTrayNotify, 0, 0)
}

func (t *tray) flushNotification() {
	t.mu.Lock()
	title, body := t.pendingT, t.pendingB
	t.mu.Unlock()
	if title == "" && body == "" {
		return
	}
	nid := t.baseData()
	nid.UFlags = nifInfo
	nid.DwInfoFlags = niifInfo
	copyUTF16(nid.SzInfoTitle[:], title)
	copyUTF16(nid.SzInfo[:], body)
	procShellNotifyIco.Call(nimModify, uintptr(unsafe.Pointer(nid)))
}

func (t *tray) Stop() {
	if t == nil || t.hwnd == 0 {
		return
	}
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	t.mu.Unlock()
	procPostMessageW.Call(uintptr(t.hwnd), wmClose, 0, 0)
	<-t.stopped
}

func loadAppIcon(instance windows.Handle) windows.Handle {
	// The executable carries the MELO icon as its first resource icon.
	if exe, err := windows.UTF16PtrFromString(exePath()); err == nil {
		if h, _, _ := procExtractIconW.Call(uintptr(instance), uintptr(unsafe.Pointer(exe)), 0); h > 1 {
			return windows.Handle(h)
		}
	}
	h, _, _ := procLoadIconW.Call(0, uintptr(idiApplication))
	return windows.Handle(h)
}

func exePath() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	return path
}

func copyUTF16(dst []uint16, s string) {
	src, err := windows.UTF16FromString(s)
	if err != nil {
		return
	}
	for i := range dst {
		dst[i] = 0
	}
	n := len(src)
	if n > len(dst) {
		n = len(dst)
		src[n-1] = 0
	}
	copy(dst[:n], src[:n])
}

func traySupport() string { return "windows-shell-notifyicon" }
