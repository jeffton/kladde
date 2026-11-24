package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
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

func normalizeCollection(value string) string {
	return strings.TrimSpace(value)
}

func noteStorageKey(title, collection string) string {
	collection = normalizeCollection(collection)
	if collection == "" {
		return title
	}
	return collection + "/" + title
}

func parseUserNoteRelPath(rel string) (title, collection string, ok bool) {
	rel = strings.TrimSpace(rel)
	if rel == "" {
		return "", "", false
	}

	parts := strings.Split(rel, string(os.PathSeparator))
	if len(parts) == 1 {
		filename := parts[0]
		if strings.HasPrefix(filename, ".") || filepath.Ext(filename) != ".md" {
			return "", "", false
		}
		title = strings.TrimSuffix(filename, ".md")
		if err := validateTitle(title); err != nil {
			return "", "", false
		}
		return title, "", true
	}

	if len(parts) == 2 {
		collection = normalizeCollection(parts[0])
		filename := parts[1]
		if strings.HasPrefix(collection, ".") || strings.HasPrefix(filename, ".") || filepath.Ext(filename) != ".md" {
			return "", "", false
		}
		title = strings.TrimSuffix(filename, ".md")
		if err := validateCollection(collection); err != nil {
			return "", "", false
		}
		if err := validateTitle(title); err != nil {
			return "", "", false
		}
		return title, collection, true
	}

	return "", "", false
}

func (s *Server) listNotes(notesDir string) ([]NoteMeta, error) {
	entries, err := os.ReadDir(notesDir)
	if err != nil {
		return nil, err
	}

	stars, err := loadStars(notesDir)
	if err != nil {
		return nil, err
	}
	result := make([]NoteMeta, 0)
	collections := make([]struct {
		name string
		path string
	}, 0)

	appendNote := func(entry fs.DirEntry, info fs.FileInfo, collection string) {
		title := strings.TrimSuffix(entry.Name(), ".md")
		key := noteStorageKey(title, collection)
		result = append(result, NoteMeta{
			Key:        key,
			Title:      title,
			Collection: collection,
			UpdatedAt:  info.ModTime(),
			Starred:    stars[key],
		})
	}

	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		if info.IsDir() {
			collection := normalizeCollection(entry.Name())
			if err := validateCollection(collection); err == nil {
				collections = append(collections, struct {
					name string
					path string
				}{name: collection, path: filepath.Join(notesDir, entry.Name())})
			}
			continue
		}
		if filepath.Ext(entry.Name()) == ".md" {
			appendNote(entry, info, "")
		}
	}

	for _, collection := range collections {
		collectionEntries, err := os.ReadDir(collection.path)
		if err != nil {
			return nil, err
		}
		for _, entry := range collectionEntries {
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return nil, err
			}
			if !info.IsDir() && filepath.Ext(entry.Name()) == ".md" {
				appendNote(entry, info, collection.name)
			}
		}
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].UpdatedAt.Equal(result[j].UpdatedAt) {
			return result[i].Key < result[j].Key
		}
		return result[i].UpdatedAt.After(result[j].UpdatedAt)
	})

	return result, nil
}

func (s *Server) getNote(notesDir, title, collection string) (*Note, error) {
	path, err := s.notePath(notesDir, title, collection)
	if err != nil {
		return nil, err
	}
	if err := rejectSymlink(path); err != nil {
		return nil, err
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	content, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}

	key := noteStorageKey(title, collection)
	stars, err := loadStars(notesDir)
	if err != nil {
		return nil, err
	}
	return &Note{
		Key:        key,
		Title:      title,
		Collection: collection,
		Content:    string(content),
		UpdatedAt:  info.ModTime(),
		Starred:    stars[key],
	}, nil
}

func loadStars(notesDir string) (map[string]bool, error) {
	path := filepath.Join(notesDir, ".stars.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return map[string]bool{}, nil
		}
		return nil, err
	}

	var titles []string
	if err := json.Unmarshal(data, &titles); err != nil {
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
			return nil, removeErr
		}
		return map[string]bool{}, nil
	}

	stars := make(map[string]bool, len(titles))
	for _, title := range titles {
		title = strings.TrimSpace(title)
		if title == "" {
			continue
		}
		stars[title] = true
	}

	return stars, nil
}

func (s *Server) setNoteStarred(notesDir, key string, starred bool) error {
	s.starsMu.Lock()
	defer s.starsMu.Unlock()

	stars, err := loadStars(notesDir)
	if err != nil {
		return err
	}
	if starred {
		stars[key] = true
	} else {
		delete(stars, key)
	}
	return saveStars(notesDir, stars)
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

	return writeFileAtomic(path, data, 0o664)
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

func (s *Server) createNote(notesDir, title, collection, content string) (*Note, error) {
	if err := validateTitle(title); err != nil {
		return nil, err
	}
	if err := validateCollection(collection); err != nil {
		return nil, err
	}

	baseTitle := title
	finalTitle := baseTitle
	for n := 2; ; n++ {
		path, err := s.notePath(notesDir, finalTitle, collection)
		if err != nil {
			return nil, err
		}

		if info, err := os.Lstat(path); err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return nil, errors.New("symlink notes are not allowed")
			}
			finalTitle = fmt.Sprintf("%s (%d)", baseTitle, n)
			continue
		} else if errors.Is(err, fs.ErrNotExist) {
			break
		} else {
			return nil, err
		}
	}

	note, _, err := s.saveNote(notesDir, finalTitle, collection, content)
	if err != nil {
		return nil, err
	}
	return note, nil
}

func (s *Server) saveNote(notesDir, title, collection, content string) (*Note, string, error) {
	path, err := s.notePath(notesDir, title, collection)
	if err != nil {
		return nil, "", err
	}
	stars, err := loadStars(notesDir)
	if err != nil {
		return nil, "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o775); err != nil {
		return nil, "", err
	}

	action := "created"
	if _, err := os.Stat(path); err == nil {
		action = "updated"
	}
	if err := writeFileAtomic(path, []byte(content), 0o664); err != nil {
		return nil, "", err
	}

	info, err := os.Stat(path)
	if err != nil {
		return nil, "", err
	}

	key := noteStorageKey(title, collection)
	return &Note{
		Key:        key,
		Title:      title,
		Collection: collection,
		Content:    content,
		UpdatedAt:  info.ModTime(),
		Starred:    stars[key],
	}, action, nil
}

func removeCollectionDirIfEmpty(notesDir, collection string) {
	collection = normalizeCollection(collection)
	if collection == "" {
		return
	}
	dir := filepath.Join(notesDir, collection)
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) > 0 {
		return
	}
	_ = os.Remove(dir)
}

func (s *Server) deleteNote(notesDir, title, collection string) error {
	s.starsMu.Lock()
	defer s.starsMu.Unlock()

	path, err := s.notePath(notesDir, title, collection)
	if err != nil {
		return err
	}
	if err := rejectSymlink(path); err != nil {
		return err
	}
	stars, err := loadStars(notesDir)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}

	key := noteStorageKey(title, collection)
	if stars[key] {
		delete(stars, key)
		if err := saveStars(notesDir, stars); err != nil {
			return err
		}
	}

	removeCollectionDirIfEmpty(notesDir, collection)

	d, err := os.Open(notesDir)
	if err == nil {
		_ = d.Sync()
		_ = d.Close()
	}

	return nil
}

func (s *Server) renameNote(notesDir, oldTitle, oldCollection, newTitle, newCollection string) (*Note, error) {
	s.starsMu.Lock()
	defer s.starsMu.Unlock()

	if err := validateTitle(newTitle); err != nil {
		return nil, err
	}
	if err := validateCollection(newCollection); err != nil {
		return nil, err
	}

	oldPath, err := s.notePath(notesDir, oldTitle, oldCollection)
	if err != nil {
		return nil, err
	}
	if err := rejectSymlink(oldPath); err != nil {
		return nil, err
	}
	if _, err := os.Stat(oldPath); err != nil {
		return nil, err
	}
	stars, err := loadStars(notesDir)
	if err != nil {
		return nil, err
	}

	finalTitle := newTitle
	finalCollection := newCollection
	if oldTitle != newTitle || oldCollection != newCollection {
		baseTitle := newTitle
		for n := 2; ; n++ {
			newPath, err := s.notePath(notesDir, finalTitle, finalCollection)
			if err != nil {
				return nil, err
			}
			if err := os.MkdirAll(filepath.Dir(newPath), 0o775); err != nil {
				return nil, err
			}

			if info, err := os.Lstat(newPath); err == nil {
				if info.Mode()&os.ModeSymlink != 0 {
					return nil, errors.New("symlink notes are not allowed")
				}
				finalTitle = fmt.Sprintf("%s (%d)", baseTitle, n)
				continue
			} else if !errors.Is(err, fs.ErrNotExist) {
				return nil, err
			}

			if err := os.Rename(oldPath, newPath); err != nil {
				if errors.Is(err, fs.ErrExist) {
					finalTitle = fmt.Sprintf("%s (%d)", baseTitle, n)
					continue
				}
				return nil, err
			}
			break
		}
	}

	oldKey := noteStorageKey(oldTitle, oldCollection)
	newKey := noteStorageKey(finalTitle, finalCollection)
	if stars[oldKey] {
		delete(stars, oldKey)
		stars[newKey] = true
		if err := saveStars(notesDir, stars); err != nil {
			return nil, err
		}
	}

	if oldCollection != finalCollection {
		removeCollectionDirIfEmpty(notesDir, oldCollection)
	}

	note, err := s.getNote(notesDir, finalTitle, finalCollection)
	if err != nil {
		return nil, err
	}
	return note, nil
}

func (s *Server) notePath(notesDir, title, collection string) (string, error) {
	if err := validateTitle(title); err != nil {
		return "", err
	}
	collection = normalizeCollection(collection)
	if err := validateCollection(collection); err != nil {
		return "", err
	}

	base, err := filepath.Abs(notesDir)
	if err != nil {
		return "", err
	}

	collectionDir := filepath.Join(base, collection)
	if collection != "" {
		if err := rejectSymlinkIfExists(collectionDir); err != nil {
			return "", err
		}
	}

	path := filepath.Join(collectionDir, title+".md")
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

func rejectSymlinkIfExists(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("symlink notes are not allowed")
	}
	return nil
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

func validateCollection(collection string) error {
	if collection == "" {
		return nil
	}
	if len([]rune(collection)) > maxCollectionLength {
		return fmt.Errorf("collection exceeds max length of %d characters", maxCollectionLength)
	}
	if strings.Contains(collection, "/") || strings.Contains(collection, "\\") || strings.Contains(collection, "..") {
		return errors.New("collection contains invalid characters")
	}
	for _, r := range collection {
		if unicode.IsControl(r) {
			return errors.New("collection contains control characters")
		}
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
