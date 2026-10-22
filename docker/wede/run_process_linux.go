//go:build linux

package terminal

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// PTY startup makes the Shell a session/group leader. Job control is disabled
// for Run, so ordinary foreground and background jobs share its group. Freeze
// it before scanning descendants to avoid a fork racing ordinary cleanup.
func killRunProcesses(pid int) error {
	signal := func(target int, sig syscall.Signal) error {
		err := syscall.Kill(target, sig)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	if err := signal(-pid, syscall.SIGSTOP); err != nil {
		return err
	}
	type proc struct{ pid, ppid, group, session int }
	entries, err := os.ReadDir("/proc")
	if err != nil {
		_ = signal(-pid, syscall.SIGCONT)
		return err
	}
	processes := make([]proc, 0, len(entries))
	for _, entry := range entries {
		n, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "stat"))
		if err != nil {
			continue
		}
		end := strings.LastIndexByte(string(data), ')')
		if end < 0 {
			continue
		}
		fields := strings.Fields(string(data[end+1:]))
		if len(fields) < 4 {
			continue
		}
		parent, _ := strconv.Atoi(fields[1])
		group, _ := strconv.Atoi(fields[2])
		sid, _ := strconv.Atoi(fields[3])
		processes = append(processes, proc{n, parent, group, sid})
	}
	owned := map[int]bool{pid: true}
	for changed := true; changed; {
		changed = false
		for _, p := range processes {
			if !owned[p.pid] && (p.session == pid || owned[p.ppid]) {
				owned[p.pid] = true
				changed = true
			}
		}
	}
	// Kill only groups in our PTY session; escaped descendants are killed by PID
	// so a descendant's new group cannot target an unrelated terminal.
	groups := map[int]bool{pid: true}
	for _, p := range processes {
		if owned[p.pid] && p.session == pid && p.group > 1 {
			groups[p.group] = true
		}
	}
	var result error
	for group := range groups {
		if err := signal(-group, syscall.SIGKILL); err != nil {
			result = errors.Join(result, fmt.Errorf("kill Run group %d: %w", group, err))
		}
	}
	for _, p := range processes {
		if owned[p.pid] && p.session != pid {
			if err := signal(p.pid, syscall.SIGKILL); err != nil {
				result = errors.Join(result, err)
			}
		}
	}
	return result
}
