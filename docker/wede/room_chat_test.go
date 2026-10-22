package chat

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestRoomChatAlwaysSendsEmptyHistoryBeforeLiveMessages(t *testing.T) {
	h := NewHub(t.TempDir(), ChannelPrivate, "")
	defer h.Close()
	id, out := h.JoinRoom("Alex", "#888888")
	defer h.Leave(id)
	var frame outEnvelope
	if err := json.Unmarshal(<-out, &frame); err != nil {
		t.Fatal(err)
	}
	if frame.Type != "history" || len(frame.Messages) != 0 {
		t.Fatalf("empty readiness frame missing: %#v", frame)
	}
	h.Post("Alex", "#888888", "ready")
	if err := json.Unmarshal(<-out, &frame); err != nil {
		t.Fatal(err)
	}
	if frame.Type != "msg" || frame.Message == nil || frame.Message.Text != "ready" {
		t.Fatal("live message was not ordered after history")
	}
}

func TestRoomChatHistoryLiveRaceDeliversEachMessageOnce(t *testing.T) {
	h := NewHub(t.TempDir(), ChannelPrivate, "")
	defer h.Close()
	for i := 0; i < 100; i++ {
		text := fmt.Sprintf("message-%03d", i)
		done := make(chan struct{})
		go func() { h.Post("Alex", "#888888", text); close(done) }()
		id, out := h.JoinRoom("Alex", "#888888")
		<-done
		var first outEnvelope
		if err := json.Unmarshal(<-out, &first); err != nil {
			t.Fatal(err)
		}
		if first.Type != "history" {
			t.Fatal("live message overtook initial history")
		}
		count := 0
		for _, message := range first.Messages {
			if message.Text == text {
				count++
			}
		}
	drain:
		for {
			select {
			case raw := <-out:
				var frame outEnvelope
				if err := json.Unmarshal(raw, &frame); err != nil {
					t.Fatal(err)
				}
				if frame.Message != nil && frame.Message.Text == text {
					count++
				}
			default:
				break drain
			}
		}
		h.Leave(id)
		if count != 1 {
			t.Fatalf("history/live race delivered %q %d times", text, count)
		}
	}
}

func TestRoomChatDisconnectDuringBroadcast(t *testing.T) {
	h := NewHub(t.TempDir(), ChannelPrivate, "")
	defer h.Close()
	for i := 0; i < 100; i++ {
		id, _ := h.JoinRoom("Alex", "#888888")
		done := make(chan struct{})
		go func() { h.Post("Alex", "#888888", "disconnect race"); close(done) }()
		h.Leave(id)
		<-done
	}
}
