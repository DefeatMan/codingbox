package terminal

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
)

func (s *session) isOpen() bool { s.mu.Lock(); defer s.mu.Unlock(); return !s.closed }

type runWorkspace string

func (w runWorkspace) Current() string     { return string(w) }
func (runWorkspace) OnChange(func(string)) {}

type RunTab struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	RunSession string `json:"runSession"`
	Generation int    `json:"generation"`
}

// RunHandler owns the room's Run PTY independently of language/manual workspaces.
// mu orders cleanup, creation, publication and close across all participants.
type RunHandler struct {
	mu       sync.Mutex
	terminal *Handler
	instance string
	revision int
	tab      *RunTab
	session  *session
}

func NewRun(root string) *RunHandler {
	terminal := New(runWorkspace(root), "")
	terminal.runOnly = true
	return &RunHandler{terminal: terminal, instance: rand.Text()}
}

func (h *RunHandler) stop() error {
	if h.session == nil {
		return nil
	}
	s := h.session
	if err := killRunProcesses(s.cmd.Process.Pid); err != nil {
		return err
	}
	s.mu.Lock()
	s.closed = true
	s.closeConns()
	s.mu.Unlock()
	_ = s.ptmx.Close()
	// Reap only here: retaining the Shell PID until group cleanup prevents reuse.
	_ = s.cmd.Wait()
	<-s.done
	h.terminal.mu.Lock()
	if h.terminal.sessions[s.id] == s {
		delete(h.terminal.sessions, s.id)
	}
	h.terminal.mu.Unlock()
	h.session = nil
	return nil
}

func (h *RunHandler) Start(name, dir, command string) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := h.stop(); err != nil {
		return 0, fmt.Errorf("stop previous Run: %w", err)
	}
	h.revision++
	h.tab = nil
	id := "codingbox-run-" + h.instance + "-" + strconv.Itoa(h.revision)
	h.terminal.mu.Lock()
	s, _, err := h.terminal.createSessionLocked(id, dir, true)
	h.terminal.mu.Unlock()
	if err != nil {
		return 0, err
	}
	h.session = s
	s.pmu.Lock()
	_, err = s.ptmx.Write([]byte(command + "\n"))
	s.pmu.Unlock()
	if err != nil {
		_ = h.stop()
		return 0, err
	}
	h.tab = &RunTab{ID: 0, Name: name, RunSession: id, Generation: h.revision}
	return 0, nil
}

func (h *RunHandler) Manage(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r.Method == http.MethodDelete {
		if err := h.stop(); err != nil {
			http.Error(w, "Unable to stop Run", 500)
			return
		}
		h.tab = nil
		h.revision++
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"instance": h.instance, "revision": h.revision, "terminal": h.tab})
}

func (h *RunHandler) HandleWS(w http.ResponseWriter, r *http.Request) { h.terminal.HandleWS(w, r) }
func (h *RunHandler) Close()                                          { h.mu.Lock(); defer h.mu.Unlock(); _ = h.stop() }
