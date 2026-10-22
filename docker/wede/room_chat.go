package chat

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"
)

// JoinRoom queues authoritative history before another post can reach this peer.
// Optional Git history runs outside the message startup path.
func (h *Hub) JoinRoom(username, color string) (string, <-chan []byte) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		ch := make(chan []byte)
		close(ch)
		return "", ch
	}
	h.counter++
	id := fmt.Sprintf("m%d", h.counter)
	p := &peer{out: make(chan []byte, peerBuf)}
	history := append([]Message{}, h.history...)
	sort.SliceStable(history, func(i, j int) bool { return history[i].Time.Before(history[j].Time) })
	data, _ := json.Marshal(struct {
		Type     string    `json:"type"`
		Messages []Message `json:"messages"`
	}{"history", history})
	p.out <- data
	h.peers[id] = p
	h.mu.Unlock()
	if h.gitOn {
		go h.sendRoomActivity(id, p)
	}
	return id, p.out
}

func (h *Hub) sendRoomActivity(id string, p *peer) {
	h.activityMu.Lock()
	if time.Since(h.activityAt) > 5*time.Second {
		h.activity = recentCommits(h.root, gitHistoryLimit)
		h.activityAt = time.Now()
	}
	activity := append([]Message(nil), h.activity...)
	h.activityMu.Unlock()
	if len(activity) == 0 {
		return
	}
	data, err := json.Marshal(outEnvelope{Type: "activity", Messages: activity})
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.peers[id] != p {
		return
	}
	select {
	case p.out <- data:
	default:
	}
}

func (h *Hub) HandleRoomWS(w http.ResponseWriter, r *http.Request) { h.handleWS(w, r, true) }
