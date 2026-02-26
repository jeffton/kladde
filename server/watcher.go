package main

import (
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

func parseWatcherNoteRelPath(rel string) (username, title, collection, key string, ok bool) {
	rel = strings.TrimSpace(rel)
	if rel == "" {
		return "", "", "", "", false
	}

	parts := strings.Split(rel, string(os.PathSeparator))
	if len(parts) < 2 || len(parts) > 3 {
		return "", "", "", "", false
	}

	username = strings.TrimSpace(parts[0])
	if username == "" {
		return "", "", "", "", false
	}

	userRel := strings.Join(parts[1:], string(os.PathSeparator))
	title, collection, parsed := parseUserNoteRelPath(userRel)
	if !parsed {
		return "", "", "", "", false
	}

	return username, title, collection, noteStorageKey(title, collection), true
}

func (s *Server) startFileWatcher() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	addDirRecursive := func(root string) error {
		return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if !d.IsDir() {
				return nil
			}
			if strings.HasPrefix(d.Name(), ".") && path != s.notesBaseDir {
				return filepath.SkipDir
			}
			if err := watcher.Add(path); err != nil {
				log.Printf("watch add failed for %s: %v", path, err)
			}
			return nil
		})
	}

	if err := addDirRecursive(s.notesBaseDir); err != nil {
		_ = watcher.Close()
		return err
	}

	debouncer := NewFileEventDebouncer()
	knownMu := &sync.Mutex{}
	knownNotes := make(map[string]struct{})

	_ = filepath.WalkDir(s.notesBaseDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(s.notesBaseDir, path)
		if relErr != nil {
			return nil
		}
		if _, _, _, _, ok := parseWatcherNoteRelPath(rel); !ok {
			return nil
		}
		knownMu.Lock()
		knownNotes[rel] = struct{}{}
		knownMu.Unlock()
		return nil
	})

	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if err := addDirRecursive(s.notesBaseDir); err != nil {
				log.Printf("watch reconcile failed: %v", err)
			}
		}
	}()

	go func() {
		defer watcher.Close()
		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}

				if event.Op&fsnotify.Create != 0 {
					if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
						if err := addDirRecursive(event.Name); err != nil {
							log.Printf("watch recurse failed for %s: %v", event.Name, err)
						}
						continue
					}
				}

				notePath := event.Name
				base := filepath.Base(notePath)

				if event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Remove|fsnotify.Rename) == 0 {
					continue
				}

				rel, err := filepath.Rel(s.notesBaseDir, notePath)
				if err != nil {
					continue
				}

				if base == ".stars.json" {
					s.triggerGitBackup("filesystem change")
					continue
				}

				username, title, collection, key, ok := parseWatcherNoteRelPath(rel)
				if !ok {
					continue
				}

				s.triggerGitBackup("filesystem change")

				action := "updated"
				switch {
				case event.Op&fsnotify.Remove != 0 || event.Op&fsnotify.Rename != 0:
					action = "deleted"
				case event.Op&fsnotify.Create != 0:
					action = "created"
				}

				debounceKey := username + ":" + notePath
				debouncer.Trigger(debounceKey, 200*time.Millisecond, func() {
					relPath, relErr := filepath.Rel(s.notesBaseDir, notePath)
					if relErr != nil {
						return
					}

					knownMu.Lock()
					_, wasKnown := knownNotes[relPath]
					_, statErr := os.Stat(notePath)
					finalAction := action

					if statErr != nil && os.IsNotExist(statErr) {
						finalAction = "deleted"
						delete(knownNotes, relPath)
					} else if statErr == nil {
						if !wasKnown {
							finalAction = "created"
						} else {
							finalAction = "updated"
						}
						knownNotes[relPath] = struct{}{}
					}
					knownMu.Unlock()

					if _, found := s.consumeRecentChangeOrigin(username, collection, title); found {
						return
					}
					s.broadcastNoteChange(username, NoteChangeEvent{
						Type:       "note_changed",
						Key:        key,
						Title:      title,
						Collection: collection,
						Action:     finalAction,
					})
				})
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}
				log.Printf("file watcher error: %v", err)
			}
		}
	}()

	return nil
}
