package chat

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ImportRoomHistory preserves the old per-language logs in the room's default
// channels. Whole-line markers and atomic replacement make retries idempotent.
func ImportRoomHistory(root string) error {
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	for _, private := range []bool{false, true} {
		suffix := filepath.Join(".wede", "chat.md")
		if private {
			suffix = filepath.Join(".wede", "private", "chat.md")
		}
		destination := filepath.Join(root, suffix)
		data, err := os.ReadFile(destination)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		changed := false
		for _, language := range []string{"python", "typescript", "go", "cpp", "rust"} {
			relative := filepath.Join("languages", language, suffix)
			marker := []byte("\n<!-- codingbox-room-chat: " + filepath.ToSlash(relative) + " -->\n")
			if bytes.Contains(data, marker) {
				continue
			}
			source := filepath.Join(root, relative)
			resolved, err := filepath.EvalSymlinks(source)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			if !strings.HasPrefix(resolved, canonical+string(filepath.Separator)) {
				return fmt.Errorf("chat history is outside room: %s", relative)
			}
			info, err := os.Stat(resolved)
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				continue
			}
			history, err := os.ReadFile(resolved)
			if err != nil {
				return err
			}
			data = append(data, marker...)
			data = append(data, history...)
			if len(data) > 0 && data[len(data)-1] != '\n' {
				data = append(data, '\n')
			}
			changed = true
		}
		if !changed {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
			return err
		}
		temp, err := os.CreateTemp(filepath.Dir(destination), ".room-chat-*")
		if err != nil {
			return err
		}
		path := temp.Name()
		_, writeErr := temp.Write(data)
		if writeErr == nil {
			writeErr = temp.Sync()
		}
		closeErr := temp.Close()
		if writeErr == nil {
			writeErr = closeErr
		}
		if writeErr == nil {
			writeErr = os.Rename(path, destination)
		}
		_ = os.Remove(path)
		if writeErr != nil {
			return writeErr
		}
	}
	return nil
}
