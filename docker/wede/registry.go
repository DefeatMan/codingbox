package terminal

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

type terminalTab struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// ManageSessions serializes metadata mutations; revisions reject stale HTTP replies.
func (h *Handler) ManageSessions(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.nextTab == 0 {
		h.nextTab = 1
		h.tabs = []terminalTab{{ID: 1, Name: "Terminal 1"}}
	}
	created := 0
	if r.Method == http.MethodPost {
		var op struct {
			Op   string `json:"op"`
			ID   int    `json:"id"`
			Name string `json:"name"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&op); err != nil {
			http.Error(w, "Invalid terminal operation", 400)
			return
		}
		switch op.Op {
		case "add":
			if len(h.tabs) >= 16 {
				http.Error(w, "Terminal limit reached", 409)
				return
			}
			name := strings.TrimSpace(op.Name)
			if len(name) > 100 {
				http.Error(w, "Name too long", 400)
				return
			}
			h.nextTab++
			created = h.nextTab
			if name == "" {
				name = fmt.Sprintf("Terminal %d", created)
			}
			h.tabs = append(h.tabs, terminalTab{ID: created, Name: name})
		case "rename":
			name := strings.TrimSpace(op.Name)
			if name == "" || len(name) > 100 {
				http.Error(w, "Invalid name", 400)
				return
			}
			for i := range h.tabs {
				if h.tabs[i].ID == op.ID {
					h.tabs[i].Name = name
				}
			}
		case "close":
			if len(h.tabs) <= 1 {
				http.Error(w, "Keep one terminal", 409)
				return
			}
			for i, tab := range h.tabs {
				if tab.ID != op.ID {
					continue
				}
				h.tabs = append(h.tabs[:i], h.tabs[i+1:]...)
				id := "term-" + strconv.Itoa(op.ID)
				if s := h.sessions[id]; s != nil {
					s.mu.Lock()
					s.closed = true
					s.closeConns()
					s.mu.Unlock()
					s.ptmx.Close()
					s.cmd.Process.Kill()
					delete(h.sessions, id)
				}
				break
			}
		default:
			http.Error(w, "Unknown terminal operation", 400)
			return
		}
		h.tabRevision++
	}
	ids := make([]string, 0, len(h.sessions))
	for id := range h.sessions {
		ids = append(ids, id)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"sessions": ids, "terminals": h.tabs, "revision": h.tabRevision, "createdId": created})
}

// Run starts exactly once on the server, independent of browser attachment/reload.
func (h *Handler) Run(name, command string) (int, error) {
	h.mu.Lock()
	if h.nextTab == 0 {
		h.nextTab = 1
		h.tabs = []terminalTab{{ID: 1, Name: "Terminal 1"}}
	}
	if len(h.tabs) >= 16 {
		h.mu.Unlock()
		return 0, fmt.Errorf("terminal limit reached; close a terminal first")
	}
	h.nextTab++
	id := h.nextTab
	h.tabs = append(h.tabs, terminalTab{ID: id, Name: name})
	h.tabRevision++
	h.mu.Unlock()
	s, _, err := h.getOrCreateSession("term-" + strconv.Itoa(id))
	if err != nil {
		return 0, err
	}
	s.pmu.Lock()
	_, err = s.ptmx.Write([]byte(command + "\n"))
	s.pmu.Unlock()
	return id, err
}
