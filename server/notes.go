package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

func (s *Server) userNotesDir(userID string) string {
	return filepath.Join(s.notesBaseDir, userID)
}

func (s *Server) triggerGitBackup(reason string) {
	if s.gitBackup == nil {
		return
	}
	s.gitBackup.Trigger(reason)
}

func (s *Server) handleNotes(w http.ResponseWriter, r *http.Request) {
	session, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	userDir := s.userNotesDir(session.User.Username)
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	switch r.Method {
	case http.MethodGet:
		notes, err := s.listNotes(userDir)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, notes)
	case http.MethodPost:
		var payload struct {
			Title   string `json:"title"`
			Content string `json:"content"`
		}
		if err := decodeJSONBody(w, r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		title := strings.TrimSpace(payload.Title)
		if err := validateTitle(title); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		note, action, err := s.saveNote(userDir, title, payload.Content)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		s.hub.Broadcast(session.User.Username, NoteChangeEvent{Type: "note_changed", Title: note.Title, Action: action})
		writeJSON(w, http.StatusCreated, note)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleNoteByTitle(w http.ResponseWriter, r *http.Request) {
	session, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	userDir := s.userNotesDir(session.User.Username)
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/api/notes/")
	rest = strings.TrimSpace(strings.TrimSuffix(rest, "/"))
	parts := strings.Split(rest, "/")

	if len(parts) == 2 && parts[1] == "rename" {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		oldTitle, err := url.PathUnescape(parts[0])
		if err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid note path encoding"))
			return
		}
		oldTitle = strings.TrimSpace(oldTitle)
		if err := validateTitle(oldTitle); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		var payload struct {
			NewTitle string `json:"newTitle"`
		}
		if err := decodeJSONBody(w, r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		note, finalTitle, err := s.renameNote(userDir, oldTitle, strings.TrimSpace(payload.NewTitle))
		if err != nil {
			switch {
			case errors.Is(err, fs.ErrNotExist):
				writeError(w, http.StatusNotFound, errors.New("note not found"))
			default:
				if strings.Contains(err.Error(), "title") {
					writeError(w, http.StatusBadRequest, err)
				} else {
					writeError(w, http.StatusInternalServerError, err)
				}
			}
			return
		}

		s.hub.Broadcast(session.User.Username, NoteChangeEvent{Type: "note_changed", Title: oldTitle, Action: "deleted"})
		s.hub.Broadcast(session.User.Username, NoteChangeEvent{Type: "note_changed", Title: finalTitle, Action: "created"})
		writeJSON(w, http.StatusOK, note)
		return
	}

	if len(parts) == 2 && parts[1] == "star" {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		title, err := url.PathUnescape(parts[0])
		if err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid note path encoding"))
			return
		}
		title = strings.TrimSpace(title)
		if err := validateTitle(title); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		var payload struct {
			Starred bool `json:"starred"`
		}
		if err := decodeJSONBody(w, r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		stars := loadStars(userDir)
		if payload.Starred {
			stars[title] = true
		} else {
			delete(stars, title)
		}

		if err := saveStars(userDir, stars); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{"title": title, "starred": payload.Starred})
		return
	}

	if len(parts) != 1 {
		writeError(w, http.StatusBadRequest, errors.New("invalid note path"))
		return
	}

	title, err := url.PathUnescape(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid note path encoding"))
		return
	}
	title = strings.TrimSpace(title)
	if err := validateTitle(title); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	switch r.Method {
	case http.MethodGet:
		note, err := s.getNote(userDir, title)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				writeError(w, http.StatusNotFound, errors.New("note not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, note)
	case http.MethodPut:
		var payload struct {
			Content string `json:"content"`
		}
		if err := decodeJSONBody(w, r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		note, action, err := s.saveNote(userDir, title, payload.Content)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		s.hub.Broadcast(session.User.Username, NoteChangeEvent{Type: "note_changed", Title: note.Title, Action: action})
		writeJSON(w, http.StatusOK, note)
	case http.MethodDelete:
		if err := s.deleteNote(userDir, title); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				writeError(w, http.StatusNotFound, errors.New("note not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		s.hub.Broadcast(session.User.Username, NoteChangeEvent{Type: "note_changed", Title: title, Action: "deleted"})
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) listNotes(notesDir string) ([]NoteMeta, error) {
	entries, err := os.ReadDir(notesDir)
	if err != nil {
		return nil, err
	}

	stars := loadStars(notesDir)

	result := make([]NoteMeta, 0)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		title := strings.TrimSuffix(entry.Name(), ".md")
		result = append(result, NoteMeta{Title: title, UpdatedAt: info.ModTime(), Starred: stars[title]})
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].UpdatedAt.After(result[j].UpdatedAt)
	})

	return result, nil
}

func (s *Server) getNote(notesDir, title string) (*Note, error) {
	path, err := s.notePath(notesDir, title)
	if err != nil {
		return nil, err
	}
	if err := rejectSymlink(path); err != nil {
		return nil, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	stars := loadStars(notesDir)
	return &Note{Title: title, Content: string(content), UpdatedAt: info.ModTime(), Starred: stars[title]}, nil
}

func loadStars(notesDir string) map[string]bool {
	path := filepath.Join(notesDir, ".stars.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return map[string]bool{}
		}
		return map[string]bool{}
	}

	var titles []string
	if err := json.Unmarshal(data, &titles); err != nil {
		return map[string]bool{}
	}

	stars := make(map[string]bool, len(titles))
	for _, title := range titles {
		title = strings.TrimSpace(title)
		if title == "" {
			continue
		}
		stars[title] = true
	}

	return stars
}

func saveStars(notesDir string, stars map[string]bool) error {
	path := filepath.Join(notesDir, ".stars.json")
	titles := make([]string, 0, len(stars))
	for title, starred := range stars {
		if starred {
			titles = append(titles, title)
		}
	}
	sort.Strings(titles)

	data, err := json.MarshalIndent(titles, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	return writeFileAtomic(path, data, 0o644)
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmpFile, err := os.CreateTemp(dir, ".kladde-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmpFile.Name()

	cleanup := func() {
		_ = os.Remove(tmpPath)
	}

	if _, err := tmpFile.Write(data); err != nil {
		_ = tmpFile.Close()
		cleanup()
		return err
	}

	if err := tmpFile.Sync(); err != nil {
		_ = tmpFile.Close()
		cleanup()
		return err
	}

	if err := tmpFile.Close(); err != nil {
		cleanup()
		return err
	}

	if err := os.Chmod(tmpPath, perm); err != nil {
		cleanup()
		return err
	}

	if err := os.Rename(tmpPath, path); err != nil {
		cleanup()
		return err
	}

	d, err := os.Open(dir)
	if err == nil {
		_ = d.Sync()
		_ = d.Close()
	}

	return nil
}

func (s *Server) saveNote(notesDir, title, content string) (*Note, string, error) {
	path, err := s.notePath(notesDir, title)
	if err != nil {
		return nil, "", err
	}
	action := "created"
	if _, err := os.Stat(path); err == nil {
		action = "updated"
	}
	if err := writeFileAtomic(path, []byte(content), 0o644); err != nil {
		return nil, "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, "", err
	}
	stars := loadStars(notesDir)
	return &Note{Title: title, Content: content, UpdatedAt: info.ModTime(), Starred: stars[title]}, action, nil
}

func (s *Server) deleteNote(notesDir, title string) error {
	path, err := s.notePath(notesDir, title)
	if err != nil {
		return err
	}
	if err := rejectSymlink(path); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}

	stars := loadStars(notesDir)
	if stars[title] {
		delete(stars, title)
		if err := saveStars(notesDir, stars); err != nil {
			return err
		}
	}

	d, err := os.Open(notesDir)
	if err == nil {
		_ = d.Sync()
		_ = d.Close()
	}

	return nil
}

func (s *Server) renameNote(notesDir, oldTitle, newTitle string) (*Note, string, error) {
	if err := validateTitle(newTitle); err != nil {
		return nil, "", err
	}

	oldPath, err := s.notePath(notesDir, oldTitle)
	if err != nil {
		return nil, "", err
	}

	if err := rejectSymlink(oldPath); err != nil {
		return nil, "", err
	}

	if _, err := os.Stat(oldPath); err != nil {
		return nil, "", err
	}

	if oldTitle != newTitle {
		baseTitle := newTitle
		for n := 2; ; n++ {
			newPath, err := s.notePath(notesDir, newTitle)
			if err != nil {
				return nil, "", err
			}

			err = os.Link(oldPath, newPath)
			if err == nil {
				if err := os.Remove(oldPath); err != nil {
					_ = os.Remove(newPath)
					return nil, "", err
				}
				break
			}

			if errors.Is(err, fs.ErrExist) {
				if info, lerr := os.Lstat(newPath); lerr == nil && info.Mode()&os.ModeSymlink != 0 {
					return nil, "", errors.New("symlink notes are not allowed")
				}
				newTitle = fmt.Sprintf("%s (%d)", baseTitle, n)
				continue
			}

			return nil, "", err
		}
	}

	stars := loadStars(notesDir)
	if stars[oldTitle] {
		delete(stars, oldTitle)
		stars[newTitle] = true
		if err := saveStars(notesDir, stars); err != nil {
			return nil, "", err
		}
	}

	note, err := s.getNote(notesDir, newTitle)
	if err != nil {
		return nil, "", err
	}
	return note, newTitle, nil
}

func (s *Server) notePath(notesDir, title string) (string, error) {
	if err := validateTitle(title); err != nil {
		return "", err
	}

	base, err := filepath.Abs(notesDir)
	if err != nil {
		return "", err
	}

	path := filepath.Join(base, title+".md")
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}

	prefix := base + string(os.PathSeparator)
	if abs != base && !strings.HasPrefix(abs, prefix) {
		return "", errors.New("invalid note path")
	}

	return abs, nil
}

func rejectSymlink(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("symlink notes are not allowed")
	}
	return nil
}

func validateTitle(title string) error {
	if title == "" {
		return errors.New("title is required")
	}
	if len([]rune(title)) > maxTitleLength {
		return fmt.Errorf("title exceeds max length of %d characters", maxTitleLength)
	}
	if strings.Contains(title, "/") || strings.Contains(title, "\\") || strings.Contains(title, "..") {
		return errors.New("title contains invalid characters")
	}
	for _, r := range title {
		if unicode.IsControl(r) {
			return errors.New("title contains control characters")
		}
	}
	return nil
}
