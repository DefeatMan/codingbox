package chat

func newPeer() *peer {
	return &peer{out: make(chan []byte, peerBuf), done: make(chan struct{})}
}

// Caller holds h.mu. A peer with a gap must reconnect and reload history;
// silently dropping a frame leaves it connected with an incomplete timeline.
func (h *Hub) enqueueLocked(id string, p *peer, data []byte) {
	if h.peers[id] != p {
		return
	}
	select {
	case p.out <- data:
	default:
		delete(h.peers, id)
		close(p.done)
		close(p.out)
	}
}

func (h *Hub) peerDone(id string) <-chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p := h.peers[id]; p != nil {
		return p.done
	}
	done := make(chan struct{})
	close(done)
	return done
}
