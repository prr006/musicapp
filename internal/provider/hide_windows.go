//go:build windows

package provider

import (
	"os/exec"
	"syscall"
)

// hideWindow prevents a console window from flashing when yt-dlp runs.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
