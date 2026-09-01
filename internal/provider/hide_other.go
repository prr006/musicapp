//go:build !windows

package provider

import "os/exec"

func hideWindow(cmd *exec.Cmd) {}
