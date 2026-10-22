//go:build linux

package terminal

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func runFile(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
			return strings.TrimSpace(string(data))
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("Run did not write %s", path)
	return ""
}
func runPID(t *testing.T, path string) int {
	t.Helper()
	n, err := strconv.Atoi(runFile(t, path))
	if err != nil {
		t.Fatal(err)
	}
	return n
}
func processAlive(pid int) bool {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false
	}
	fields := strings.Fields(string(data[strings.LastIndexByte(string(data), ')')+1:]))
	return len(fields) > 0 && fields[0] != "Z"
}

func TestRunReplacesShellAndGroupWithoutTouchingManualTerminal(t *testing.T) {
	t.Setenv("RUN_DIRTY", "baseline")
	root := t.TempDir()
	next := filepath.Join(root, "next")
	os.Mkdir(next, 0700)
	h := NewRun(root)
	defer h.Close()
	manual := New(runWorkspace(root), "")
	s, _, err := manual.getOrCreateSession("term-1")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { manual.Close(); _ = s.cmd.Wait() }()
	manualPID := s.cmd.Process.Pid
	firstShell, background := filepath.Join(root, "first"), filepath.Join(root, "background")
	id, err := h.Start("Run · Python", root, fmt.Sprintf("echo $$ > %q; export RUN_DIRTY=dirty; cd /tmp; sleep 120 & echo $! > %q; cat", firstShell, background))
	if err != nil {
		t.Fatal(err)
	}
	firstPID := runPID(t, firstShell)
	firstSession := h.tab.RunSession
	backgroundPID := runPID(t, background)
	if !processAlive(firstPID) || !processAlive(backgroundPID) {
		t.Fatal("first run not alive before replacement")
	}
	secondShell, dirFile, envFile := filepath.Join(root, "second"), filepath.Join(root, "dir"), filepath.Join(root, "env")
	nextID, err := h.Start("Run · Go", next, fmt.Sprintf("echo $$ > %q; pwd > %q; printf '%%s' \"$RUN_DIRTY\" > %q; cat", secondShell, dirFile, envFile))
	if err != nil {
		t.Fatal(err)
	}
	if id != nextID || id != 0 {
		t.Fatalf("dedicated tab identity changed: %d %d", id, nextID)
	}
	secondPID := runPID(t, secondShell)
	if secondPID == firstPID || processAlive(firstPID) || processAlive(backgroundPID) {
		t.Fatal("old Shell/background survived replacement")
	}
	if runFile(t, dirFile) != next || runFile(t, envFile) != "baseline" {
		t.Fatal("working directory or environment leaked between runs")
	}
	if !processAlive(manualPID) {
		t.Fatal("manual terminal was killed")
	}
	if _, _, err := h.terminal.getOrCreateSession(firstSession); err == nil {
		t.Fatal("old reconnect recreated a stopped run")
	}
	prompts := strings.Count(string(h.session.buf.Bytes()), "bash-")
	h.session.pmu.Lock()
	_, err = h.session.ptmx.Write([]byte("\x03"))
	h.session.pmu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for strings.Count(string(h.session.buf.Bytes()), "bash-") <= prompts && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	after := filepath.Join(root, "after-interrupt")
	h.session.pmu.Lock()
	_, err = h.session.ptmx.Write([]byte(fmt.Sprintf("echo $$ > %q\n", after)))
	h.session.pmu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if runPID(t, after) != secondPID {
		t.Fatal("Ctrl+C killed the interactive Shell")
	}
	h.Close()
	if processAlive(secondPID) {
		t.Fatal("close retained the Run Shell")
	}
	if syscall.Kill(manualPID, 0) != nil {
		t.Fatal("close affected a manual terminal")
	}
}

func TestRunMetadataAndSocketIdentifyServerInstance(t *testing.T) {
	root := t.TempDir()
	first, second := NewRun(root), NewRun(root)
	defer first.Close()
	defer second.Close()
	if first.instance == "" || first.instance == second.instance {
		t.Fatal("server restart reused Run instance identity")
	}
	if _, err := first.Start("Run", root, "true"); err != nil {
		t.Fatal(err)
	}
	if first.tab.RunSession != "codingbox-run-"+first.instance+"-1" {
		t.Fatal("socket identity does not include server instance")
	}
	response := httptest.NewRecorder()
	first.Manage(response, httptest.NewRequest("GET", "/", nil))
	var state struct {
		Instance string `json:"instance"`
		Revision int    `json:"revision"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if state.Instance != first.instance || state.Revision != 1 {
		t.Fatal("Run metadata cannot distinguish server restart")
	}
}

func TestConcurrentRunsSerializeAndPublishOnlyOneGeneration(t *testing.T) {
	root := t.TempDir()
	h := NewRun(root)
	defer h.Close()
	var wg sync.WaitGroup
	failures := make(chan error, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := h.Start("Run", root, "cat")
			if err != nil {
				failures <- err
			}
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	if h.revision != 6 || h.tab == nil || h.tab.Generation != 6 {
		t.Fatalf("wrong published state: %#v", h.tab)
	}
	h.terminal.mu.Lock()
	count := len(h.terminal.sessions)
	h.terminal.mu.Unlock()
	if count != 1 {
		t.Fatalf("%d sessions remain", count)
	}
}
