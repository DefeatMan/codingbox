package collabdoc

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"

	"github.com/reearth/ygo/crdt"
)

// Preserve operation identities when ygo evicts a document after its last peer
// disconnects. Re-seeding plain text with new IDs duplicates a reconnecting doc.
func (p *DiskPersistence) statePath(room string) string {
	return filepath.Join(p.root, ".wede", "collab", fmt.Sprintf("%x.bin", sha256.Sum256([]byte(decodeRoom(room)))))
}

func (p *DiskPersistence) LoadDoc(room string) ([]byte, error) {
	if _, ok := safeJoin(p.root, decodeRoom(room)); !ok {
		return nil, nil
	}
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	if d := p.states[room]; d != nil {
		return crdt.EncodeStateAsUpdateV1(d, nil), nil
	}
	data, err := os.ReadFile(p.statePath(room))
	if os.IsNotExist(err) {
		data, err = p.seedDoc(room)
	} else if err != nil {
		return nil, err
	}
	if err != nil {
		return nil, err
	}
	d := crdt.New()
	if len(data) > 0 {
		if err := crdt.ApplyUpdateV1(d, data, nil); err != nil {
			return nil, err
		}
		if err := writeAtomic(p.statePath(room), data); err != nil {
			return nil, err
		}
	}
	p.states[room] = d
	return data, nil
}

func (p *DiskPersistence) retainUpdate(room string, update []byte) error {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	d := p.states[room]
	if d == nil || len(update) == 0 {
		return nil
	}
	if err := crdt.ApplyUpdateV1(d, update, nil); err != nil {
		return err
	}
	return writeAtomic(p.statePath(room), crdt.EncodeStateAsUpdateV1(d, nil))
}

func (p *DiskPersistence) retainedText(room string) (string, bool) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	d := p.states[room]
	if d == nil {
		return "", false
	}
	return d.GetText(contentField).ToString(), true
}
