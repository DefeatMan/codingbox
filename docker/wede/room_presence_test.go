package chat

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRoomPresenceTracksSessionsAndDebouncesReconnect(t *testing.T) {
	h := NewHub(t.TempDir(), ChannelPrivate, "")
	defer h.Close()
	join := func(identity string) string {
		id, _ := h.JoinRoom("Candidate", "#888888")
		h.joinRoomMember(id, identity, "Candidate")
		return id
	}
	leave := func(id string) { h.leaveRoomMember(id); h.Leave(id) }
	first, second := join("session-a"), join("session-a")
	if len(h.history) != 1 || h.history[0].Text != "Candidate 已上线" {
		t.Fatal(h.history)
	}
	leave(first)
	if h.roomMembers["session-a"].timer != nil {
		t.Fatal("another tab still connected")
	}
	leave(second)
	member := h.roomMembers["session-a"]
	staleGeneration := member.generation
	third := join("session-a")
	h.expireRoomMember("session-a", member, staleGeneration)
	if len(h.history) != 1 {
		t.Fatal("reconnect generated presence noise", h.history)
	}
	leave(third)
	h.expireRoomMember("session-a", member, member.generation)
	if len(h.history) != 2 || h.history[1].Text != "Candidate 已离开" {
		t.Fatal(h.history)
	}
	join("session-a")
	join("session-b")
	if len(h.history) != 4 {
		t.Fatal("same display name merged distinct sessions", h.history)
	}
}

func TestRoomPresenceDepartureTimerAndShutdown(t *testing.T) {
	h := NewHub(t.TempDir(), ChannelPrivate, "")
	defer h.Close()
	id, out := h.JoinRoom("Candidate", "#888888")
	<-out
	h.joinRoomMember(id, "session", "Candidate")
	<-out
	h.leaveRoomMember(id)
	select {
	case <-out:
		t.Fatal("departure published without reconnect grace")
	default:
	}
	select {
	case raw := <-out:
		var frame outEnvelope
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Message == nil || frame.Message.Kind != "system" || frame.Message.Text != "Candidate 已离开" {
			t.Fatalf("unexpected departure frame: %s", raw)
		}
	case <-time.After(roomLeaveGrace + time.Second):
		t.Fatal("departure never published")
	}
	h.Leave(id)
	id, _ = h.JoinRoom("Candidate", "#888888")
	h.joinRoomMember(id, "session", "Candidate")
	h.leaveRoomMember(id)
	member := h.roomMembers["session"]
	h.Close()
	h.expireRoomMember("session", member, member.generation)
	if h.roomMembers != nil || h.roomPeerMembers != nil {
		t.Fatal("presence retained after close")
	}
}

func TestRoomPresencePersistsSafeSystemMessages(t *testing.T) {
	root := t.TempDir()
	h := NewHub(root, ChannelPrivate, "")
	id, _ := h.JoinRoom("Candidate", "#888888")
	h.joinRoomMember(id, "session", "Candidate\n- injected\tname")
	h.leaveRoomMember(id)
	member := h.roomMembers["session"]
	h.expireRoomMember("session", member, member.generation)
	h.Close()
	restored := NewHub(root, ChannelPrivate, "")
	defer restored.Close()
	if len(restored.history) != 2 {
		t.Fatal(restored.history)
	}
	for _, message := range restored.history {
		if message.Kind != "system" || strings.ContainsAny(message.Text, "\n\t") {
			t.Fatal(message)
		}
	}
}

func TestRoomIdentityUsesAuthenticatedSessionCredential(t *testing.T) {
	request := httptest.NewRequest("GET", "/chat", nil)
	request.Header.Set("Sec-WebSocket-Protocol", "auth.session-a")
	first := roomIdentity(request)
	request.Header.Set("Sec-WebSocket-Protocol", "auth.session-b")
	if first == roomIdentity(request) || strings.Contains(first, "session-a") {
		t.Fatal("invalid session identity")
	}
	request.Header.Set("Authorization", "session-a")
	if first != roomIdentity(request) {
		t.Fatal("authorization forms differ")
	}
	request.Header.Del("Authorization")
	request.Header.Del("Sec-WebSocket-Protocol")
	request.URL.RawQuery = "token=session-a"
	if first != roomIdentity(request) {
		t.Fatal("query authorization differs")
	}
}
