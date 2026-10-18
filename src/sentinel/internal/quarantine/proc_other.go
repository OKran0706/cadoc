//go:build !linux

package quarantine

import "errors"

// SystemDeps: quarantine only works on Linux; every action is refused elsewhere.
func SystemDeps() Deps {
	unsupported := errors.New("process quarantine requires linux")
	return Deps{
		ReadExe:  func(int) (string, error) { return "", unsupported },
		ReadComm: func(int) (string, error) { return "", unsupported },
		Kill:     func(int) error { return unsupported },
	}
}
