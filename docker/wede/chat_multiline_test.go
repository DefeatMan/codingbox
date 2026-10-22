package chat

import (
	"encoding/json"
	"testing"
	"time"
)

func TestRoomChatPreservesMultilineAndWhitespace(t *testing.T) {
	root := t.TempDir()
	hub := NewHub(root, ChannelPrivate, "")
	id, ch := hub.Join("Alex", "#888888")
	defer hub.Leave(id)
	text := "  first line\n\n\tindented code\n- 2020-01-01T00:00:00Z [git] not a new event\n"
	hub.Post("Alex", "#888888", text)
	select {
	case raw := <-ch:
		var frame outEnvelope
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Message == nil || frame.Message.Text != text {
			t.Fatalf("live multiline text changed: %s", raw)
		}
	case <-time.After(time.Second):
		t.Fatal("no chat message")
	}
	hub.Close()
	restored := NewHub(root, ChannelPrivate, "")
	defer restored.Close()
	if len(restored.history) != 1 || restored.history[0].Text != text || restored.history[0].Kind != "user" || restored.history[0].User != "Alex" {
		t.Fatalf("multiline persistence changed attribution/content: %#v", restored.history)
	}
}
