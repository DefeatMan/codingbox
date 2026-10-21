package terminal

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestSharedTerminalRegistry(t *testing.T) {
	h := &Handler{sessions: make(map[string]*session)}
	request := func(method, body string) map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		h.ManageSessions(w, httptest.NewRequest(method, "/", strings.NewReader(body)))
		if w.Code != 200 {
			t.Errorf("status %d: %s", w.Code, w.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Error(err)
		}
		return result
	}
	request("GET", "")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); request("POST", `{"op":"add"}`) }()
	}
	wg.Wait()
	state := request("GET", "")
	tabs := state["terminals"].([]any)
	if len(tabs) != 9 {
		t.Fatalf("got %d tabs", len(tabs))
	}
	seen := make(map[float64]bool)
	for _, raw := range tabs {
		id := raw.(map[string]any)["id"].(float64)
		if seen[id] {
			t.Fatalf("duplicate ID %v", id)
		}
		seen[id] = true
	}
	request("POST", `{"op":"rename","id":2,"name":"Shared"}`)
	request("POST", `{"op":"close","id":2}`)
	state = request("GET", "")
	if len(state["terminals"].([]any)) != 8 {
		t.Fatal("closed tab remains")
	}
	if state["revision"] != float64(10) {
		t.Fatal("revision did not advance")
	}
	if _, _, err := h.getOrCreateSession("term-2"); err == nil {
		t.Fatal("closed tab can recreate its PTY")
	}
}
