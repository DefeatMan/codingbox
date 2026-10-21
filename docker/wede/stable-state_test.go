package collabdoc

import (
	"github.com/reearth/ygo/crdt"
	"os"
	"path/filepath"
	"testing"
)

func TestReconnectPreservesOperationIdentity(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\n"), 0600); err != nil {
		t.Fatal(err)
	}
	p := NewDiskPersistence(root)
	seed, err := p.LoadDoc("main.go")
	if err != nil {
		t.Fatal(err)
	}
	client := crdt.New()
	if err := crdt.ApplyUpdateV1(client, seed, nil); err != nil {
		t.Fatal(err)
	}
	text := client.GetText(contentField)
	client.Transact(func(txn *crdt.Transaction) { text.Insert(txn, len("package main\n"), "// edit\n", nil) })
	if err := p.StoreUpdate("main.go", crdt.EncodeStateAsUpdateV1(client, nil)); err != nil {
		t.Fatal(err)
	}
	want := client.GetText(contentField).ToString()
	for i := 0; i < 3; i++ {
		// Simulate a provider eviction, then a complete process restart.
		if i == 2 {
			p = NewDiskPersistence(root)
		}
		state, err := p.LoadDoc("main.go")
		if err != nil {
			t.Fatal(err)
		}
		if err := crdt.ApplyUpdateV1(client, state, nil); err != nil {
			t.Fatal(err)
		}
		if got := client.GetText(contentField).ToString(); got != want {
			t.Fatalf("reconnect duplicated source: %q", got)
		}
	}
	// Text materialization still works after the live provider evicts the doc.
	p.materialize(&fakeProvider{}, "main.go")
	data, _ := os.ReadFile(filepath.Join(root, "main.go"))
	if string(data) != want {
		t.Fatalf("disk lost edits: %q", data)
	}
}
