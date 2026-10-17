//go:build linux

package quarantine

import (
	"os"
	"strconv"
	"syscall"
)

// SystemDeps wires Execute to the real /proc and SIGKILL.
func SystemDeps() Deps {
	return Deps{
		Self:   os.Getpid(),
		Parent: os.Getppid(),
		ReadExe: func(pid int) (string, error) {
			return os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
		},
		Kill: func(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) },
	}
}
