//go:build !linux

package terminal

import "errors"

func killRunProcesses(int) error { return errors.New("Run process cleanup requires Linux") }
