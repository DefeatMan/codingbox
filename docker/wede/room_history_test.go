package chat

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRoomChatImportsLegacyLanguagesOnceWithoutMixingChannels(t *testing.T) {
	root := t.TempDir()
	for _, channel := range []string{ChannelPublic, ChannelPrivate} {
		suffix := filepath.Join(".wede", "chat.md")
		if channel == ChannelPrivate {
			suffix = filepath.Join(".wede", "private", "chat.md")
		}
		for _, language := range []string{"go", "rust"} {
			path := filepath.Join(root, "languages", language, suffix)
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			record := formatLine(Message{User: "Alex", Kind: "user", Text: channel + "-" + language, Time: time.Now()})
			if err := os.WriteFile(path, []byte(record), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	for i := 0; i < 2; i++ {
		if err := ImportRoomHistory(root); err != nil {
			t.Fatal(err)
		}
	}
	for _, channel := range []string{ChannelPublic, ChannelPrivate} {
		h := NewHub(root, channel, "")
		if len(h.history) != 2 {
			t.Fatalf("import was duplicated/lost: %#v", h.history)
		}
		for _, message := range h.history {
			if message.Text != channel+"-go" && message.Text != channel+"-rust" {
				t.Fatal("chat channel crossed")
			}
		}
		h.Close()
	}
	if _, err := os.Stat(filepath.Join(root, "languages", "go", ".wede", "chat.md")); err != nil {
		t.Fatal("legacy history was removed")
	}
}
