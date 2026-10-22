package interview

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"wede/backend/internal/folder"
	"wede/backend/internal/workspace"
)

func TestSwitchPreservesProjectsAndSelection(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "project")
	templates := filepath.Join(base, "templates")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("original Go edit"), 0600); err != nil {
		t.Fatal(err)
	}
	for key, lang := range languages {
		path := filepath.Join(templates, key, lang.Entry)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(key+" starter"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	manager := workspace.NewManager("", base)
	manager.Register("default", folder.New(root))
	h := New(root, templates, manager)
	request := func(key string) map[string]any {
		t.Helper()
		method, body := "GET", ""
		if key != "" {
			method, body = "POST", `{"language":"`+key+`"}`
		}
		res := httptest.NewRecorder()
		h.Handle(res, httptest.NewRequest(method, "/", strings.NewReader(body)))
		if res.Code != 200 {
			t.Fatalf("switch %s: %d %s", key, res.Code, res.Body.String())
		}
		var data map[string]any
		if err := json.Unmarshal(res.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		return data
	}
	if request("")["language"] != "go" {
		t.Fatal("initial language not detected")
	}
	rust := request("rust")
	rustID := rust["workspaceId"]
	file := filepath.Join(root, "languages/rust/src/main.rs")
	if err := os.WriteFile(file, []byte("my Rust edit"), 0600); err != nil {
		t.Fatal(err)
	}
	request("go")
	if request("rust")["workspaceId"] != rustID {
		t.Fatal("duplicate workspace created")
	}
	data, _ := os.ReadFile(file)
	if string(data) != "my Rust edit" {
		t.Fatal("switch overwrote user code")
	}
	original, _ := os.ReadFile(filepath.Join(root, "main.go"))
	if string(original) != "original Go edit" {
		t.Fatal("initial code changed")
	}
	h = New(root, templates, manager)
	if request("")["language"] != "rust" {
		t.Fatal("selection lost on restart")
	}
	res := httptest.NewRecorder()
	h.Handle(res, httptest.NewRequest("POST", "/", strings.NewReader(`{"language":"../../bad"}`)))
	if res.Code != 400 {
		t.Fatal("unsupported language accepted")
	}
	outside := filepath.Join(base, "outside")
	os.Mkdir(outside, 0755)
	os.Symlink(outside, filepath.Join(root, "languages/cpp"))
	res = httptest.NewRecorder()
	h.Handle(res, httptest.NewRequest("POST", "/", strings.NewReader(`{"language":"cpp"}`)))
	if res.Code != 409 {
		t.Fatal("symlink project accepted")
	}
	if request("")["language"] != "rust" {
		t.Fatal("failed switch changed shared selection")
	}
}

func TestRunRejectsStaleLanguageAndIgnoresClientCommand(t *testing.T) {
	base := t.TempDir()
	os.WriteFile(filepath.Join(base, "main.py"), []byte("print('ok')"), 0600)
	manager := workspace.NewManager("", base)
	manager.Register("default", folder.New(base))
	defer manager.Close("default")
	h := New(base, base, manager)
	defer h.Runner.Close()
	for _, body := range []string{`{"language":"go","revision":0}`, `{"language":"python","revision":9}`} {
		res := httptest.NewRecorder()
		h.Run(res, httptest.NewRequest("POST", "/", strings.NewReader(body)))
		if res.Code != 409 {
			t.Fatalf("stale run: %d", res.Code)
		}
	}
	res := httptest.NewRecorder()
	h.Run(res, httptest.NewRequest("POST", "/", strings.NewReader(`{"language":"python","revision":0,"command":"touch PWNED"}`)))
	if res.Code != 200 {
		t.Fatalf("run: %d %s", res.Code, res.Body.String())
	}
	var data map[string]any
	json.Unmarshal(res.Body.Bytes(), &data)
	if data["terminalId"].(float64) != 0 {
		t.Fatal("missing shared terminal")
	}
	if _, err := os.Stat(filepath.Join(base, "PWNED")); !os.IsNotExist(err) {
		t.Fatal("client supplied command executed")
	}
}
