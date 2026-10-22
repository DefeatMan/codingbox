package chat

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"
)

const roomLeaveGrace = 2 * time.Second

type roomMember struct {
	name        string
	connections int
	generation  uint64
	timer       *time.Timer
}

// Authentication has already validated the token. Keep only its digest here;
// display names cannot identify members because different people may share one.
func roomIdentity(r *http.Request) string {
	token := r.Header.Get("Authorization")
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	if token == "" {
		for _, protocol := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
			if protocol = strings.TrimSpace(protocol); strings.HasPrefix(protocol, "auth.") {
				token = strings.TrimPrefix(protocol, "auth.")
				break
			}
		}
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(token)))
}

func (h *Hub) joinRoomMember(peerID, identity, name string) {
	h.mu.Lock()
	if h.closed || h.peers[peerID] == nil {
		h.mu.Unlock()
		return
	}
	if h.roomMembers == nil {
		h.roomMembers = make(map[string]*roomMember)
		h.roomPeerMembers = make(map[string]string)
	}
	if _, exists := h.roomPeerMembers[peerID]; exists {
		h.mu.Unlock()
		return
	}
	member := h.roomMembers[identity]
	var event *Message
	if member == nil {
		name = strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return ' '
			}
			return r
		}, name)
		member = &roomMember{name: name}
		h.roomMembers[identity] = member
		event = h.roomPresenceLocked(name + " 已上线")
	}
	member.connections++
	member.generation++
	if member.timer != nil {
		member.timer.Stop()
		member.timer = nil
	}
	h.roomPeerMembers[peerID] = identity
	h.mu.Unlock()
	if event != nil {
		h.appendToDisk(*event)
	}
}

func (h *Hub) leaveRoomMember(peerID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	identity, exists := h.roomPeerMembers[peerID]
	if !exists || h.closed {
		return
	}
	delete(h.roomPeerMembers, peerID)
	member := h.roomMembers[identity]
	member.connections--
	member.generation++
	if member.connections != 0 {
		return
	}
	generation := member.generation
	member.timer = time.AfterFunc(roomLeaveGrace, func() { h.expireRoomMember(identity, member, generation) })
}

func (h *Hub) expireRoomMember(identity string, member *roomMember, generation uint64) {
	h.mu.Lock()
	if h.closed || h.roomMembers[identity] != member || member.connections != 0 || member.generation != generation {
		h.mu.Unlock()
		return
	}
	if member.timer != nil {
		member.timer.Stop()
	}
	delete(h.roomMembers, identity)
	event := h.roomPresenceLocked(member.name + " 已离开")
	h.mu.Unlock()
	h.appendToDisk(*event)
}

// Caller holds h.mu, so history, presence transitions and peer fanout are ordered.
func (h *Hub) roomPresenceLocked(text string) *Message {
	event := &Message{ID: h.nextID(), Kind: "system", Text: text, Time: time.Now().UTC()}
	h.history = append(h.history, *event)
	data, _ := json.Marshal(outEnvelope{Type: "msg", Message: event})
	for _, peer := range h.peers {
		select {
		case peer.out <- data:
		default:
		}
	}
	return event
}

func (h *Hub) cancelRoomPresenceLocked() {
	for _, member := range h.roomMembers {
		if member.timer != nil {
			member.timer.Stop()
		}
	}
	h.roomMembers = nil
	h.roomPeerMembers = nil
}
