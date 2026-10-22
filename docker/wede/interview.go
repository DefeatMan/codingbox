package interview

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"wede/backend/internal/chat"

	"wede/backend/internal/terminal"
	"wede/backend/internal/workspace"
)

type language struct{ Label, Entry, Command string }

var languages = map[string]language{
	"python":     {"Python", "main.py", "python3 main.py"},
	"typescript": {"TypeScript", "main.ts", "tsx main.ts"},
	"go":         {"Go", "main.go", "go run ."},
	"cpp":        {"C++", "main.cpp", "g++ -std=c++20 main.cpp -o /tmp/interview && /tmp/interview"},
	"rust":       {"Rust", "src/main.rs", "cargo run --quiet"},
}

type selection struct {
	Initial  string `json:"initial"`
	Language string `json:"language"`
	Revision int    `json:"revision"`
}
type Handler struct {
	mu              sync.Mutex
	root, templates string
	manager         *workspace.Manager
	state           selection
	Runner          *terminal.RunHandler
}

func New(root, templates string, manager *workspace.Manager) *Handler {
	if canonical, err := filepath.EvalSymlinks(root); err == nil {
		root = canonical
	}
	if err := chat.ImportRoomHistory(root); err != nil {
		log.Printf("[interview] room chat import: %v", err)
	}
	h := &Handler{root: root, templates: templates, manager: manager, Runner: terminal.NewRun(root)}
	data, err := os.ReadFile(filepath.Join(root, ".wede", "interview-language.json"))
	if err == nil {
		_ = json.Unmarshal(data, &h.state)
	}
	if _, ok := languages[h.state.Initial]; !ok {
		for _, key := range []string{"go", "python", "typescript", "cpp", "rust"} {
			if _, err := os.Stat(filepath.Join(root, languages[key].Entry)); err == nil {
				h.state.Initial = key
				break
			}
		}
	}
	if h.state.Initial == "" {
		h.state.Initial = "python"
	}
	if _, ok := languages[h.state.Language]; !ok {
		h.state.Language = h.state.Initial
	}
	return h
}

// Existing files are never replaced. Reject symlink directories before copying.
func directory(path string) error {
	if err := os.Mkdir(path, 0755); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("expected a real directory")
	}
	return nil
}
func copyProject(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, rel)
		if entry.IsDir() {
			return directory(destination)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("template symlink rejected")
		}
		out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if os.IsExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		in, err := os.Open(path)
		if err != nil {
			out.Close()
			return err
		}
		_, err = io.Copy(out, in)
		in.Close()
		closeErr := out.Close()
		if err != nil {
			return err
		}
		return closeErr
	})
}
func (h *Handler) project(key string) string {
	if key == h.state.Initial {
		return h.root
	}
	return filepath.Join(h.root, "languages", key)
}
func (h *Handler) workspace(key string) (*workspace.Workspace, error) {
	path := h.project(key)
	for _, ws := range h.manager.List() {
		canonical, err := filepath.EvalSymlinks(ws.Root())
		if err == nil && canonical == path {
			return ws, nil
		}
	}
	return h.manager.Create(languages[key].Label, path)
}
func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	fail := func(status int) {
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]string{"error": "语言切换失败，请重试。"})
	}
	if r.Method == http.MethodPost {
		var body struct {
			Language string `json:"language"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			fail(400)
			return
		}
		if _, ok := languages[body.Language]; !ok {
			fail(400)
			return
		}
		if body.Language != h.state.Initial {
			if err := directory(filepath.Join(h.root, "languages")); err != nil {
				fail(409)
				return
			}
			if err := copyProject(filepath.Join(h.templates, body.Language), h.project(body.Language)); err != nil {
				fail(409)
				return
			}
		}
		if _, err := h.workspace(body.Language); err != nil {
			fail(500)
			return
		}
		next := h.state
		if next.Language != body.Language {
			next.Language = body.Language
			next.Revision++
		}
		stateDir := filepath.Join(h.root, ".wede")
		if err := directory(stateDir); err != nil {
			fail(409)
			return
		}
		data, _ := json.Marshal(next)
		temp, err := os.CreateTemp(stateDir, ".language-*")
		if err != nil {
			fail(500)
			return
		}
		path := temp.Name()
		defer os.Remove(path)
		_, err = temp.Write(data)
		closeErr := temp.Close()
		if err != nil || closeErr != nil {
			fail(500)
			return
		}
		if err := os.Rename(path, filepath.Join(stateDir, "interview-language.json")); err != nil {
			fail(500)
			return
		}
		h.state = next
	}
	ws, err := h.workspace(h.state.Language)
	if err != nil {
		fail(500)
		return
	}
	lang := languages[h.state.Language]
	json.NewEncoder(w).Encode(map[string]any{
		"language": h.state.Language, "revision": h.state.Revision, "workspaceId": ws.ID,
		"entry": lang.Entry, "command": lang.Command, "root": ws.Root(),
	})
}

// Run rejects a stale language selection rather than running a different project.
func (h *Handler) Run(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	var body struct {
		Language string `json:"language"`
		Revision int    `json:"revision"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "Invalid run request", 400)
		return
	}
	if body.Language != h.state.Language || body.Revision != h.state.Revision {
		http.Error(w, "Language changed; retry", 409)
		return
	}
	ws, err := h.workspace(h.state.Language)
	if err != nil {
		http.Error(w, "Project unavailable", 500)
		return
	}
	lang := languages[h.state.Language]
	// A fresh binary path prevents C++ runs from overwriting a running executable.
	command := lang.Command
	if h.state.Language == "cpp" {
		command = `out=$(mktemp /tmp/codingbox-run.XXXXXX) && (g++ -std=c++20 main.cpp -o "$out" && "$out"); status=$?; rm -f "$out"; (exit "$status")`
	}
	command += `; printf '\n[退出码 %s]\n' "$?"`
	id, err := h.Runner.Start("Run · "+lang.Label, ws.Root(), command)
	if err != nil {
		http.Error(w, "无法重启运行终端，请重试。", 409)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"terminalId": id, "workspaceId": ws.ID})
}

// Chat remains attached to the initial project, independent of selected language.
func (h *Handler) Chat(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	ws, err := h.workspace(h.state.Initial)
	h.mu.Unlock()
	if err != nil {
		http.Error(w, "Room chat unavailable", 503)
		return
	}
	ws.Chat(r.URL.Query().Get("channel")).HandleRoomWS(w, r)
}
