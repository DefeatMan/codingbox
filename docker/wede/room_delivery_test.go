package chat

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestSlowRoomPeerReconnectsWithCompleteHistory(t *testing.T) {
	h := NewHub(t.TempDir(), ChannelPrivate, "")
	defer h.Close()
	slow, out := h.JoinRoom("Slow", "#888")
	<-out
	disconnected := h.peerDone(slow)
	fast, live := h.JoinRoom("Fast", "#888")
	defer h.Leave(fast)
	<-live
	for i := 0; i < 100; i++ {
		h.Post("Writer", "#888", fmt.Sprintf("message-%03d", i))
		var frame outEnvelope
		if err := json.Unmarshal(<-live, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Message == nil || frame.Message.Text != fmt.Sprintf("message-%03d", i) {
			t.Fatalf("healthy peer missed message %d", i)
		}
	}
	select {
	case <-disconnected:
	default:
		t.Fatal("slow peer stayed connected with a gap")
	}
	h.Leave(slow) // Overflow and read-loop cleanup must be idempotent.
	id, replay := h.JoinRoom("Slow", "#888")
	defer h.Leave(id)
	var history outEnvelope
	if err := json.Unmarshal(<-replay, &history); err != nil {
		t.Fatal(err)
	}
	if history.Type != "history" || len(history.Messages) != 100 {
		t.Fatalf("incomplete replay: %d messages", len(history.Messages))
	}
}

func TestPresenceAndActivityOverflowDisconnectPeers(t *testing.T) {
	for _, kind := range []string{"presence", "activity"} {
		t.Run(kind, func(t *testing.T) {
			h := NewHub(t.TempDir(), ChannelPrivate, "")
			defer h.Close()
			id, out := h.JoinRoom("Slow", "#888")
			<-out
			done := h.peerDone(id)
			for i := 0; i < peerBuf; i++ {
				h.Post("Writer", "#888", "fill queue")
			}
			if kind == "presence" {
				h.joinRoomMember(id, "session", "Slow")
			} else {
				h.activityAt = time.Now()
				h.activity = []Message{{ID: "commit", Kind: "git"}}
				h.sendRoomActivity(id, h.peers[id])
			}
			select {
			case <-done:
			default:
				t.Fatal("overflow failed to disconnect")
			}
			h.leaveRoomMember(id)
			h.Leave(id)
		})
	}
}

func TestRoomWriterShutdownClosesSocketAndReader(t *testing.T) {
	h := NewHub(t.TempDir(), ChannelPrivate, "")
	defer h.Close()
	server := httptest.NewServer(http.HandlerFunc(h.HandleRoomWS))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := conn.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	h.Close()
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			if timeout, ok := err.(interface{ Timeout() bool }); ok && timeout.Timeout() {
				t.Fatal("writer exited without closing the connection")
			}
			break
		}
	}
}
