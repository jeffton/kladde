package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLoadStarsRemovesCorruptFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".stars.json")
	if err := os.WriteFile(path, []byte("not JSON"), 0o644); err != nil {
		t.Fatalf("write stars file failed: %v", err)
	}

	stars, err := loadStars(dir)
	if err != nil {
		t.Fatalf("load stars failed: %v", err)
	}
	if len(stars) != 0 {
		t.Fatalf("expected corrupt stars to be cleared, got %v", stars)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected corrupt stars file to be removed, stat error=%v", err)
	}
}

func TestLoadStarsReturnsFilesystemErrors(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, ".stars.json"), 0o755); err != nil {
		t.Fatalf("create stars directory failed: %v", err)
	}

	if _, err := loadStars(dir); err == nil {
		t.Fatal("expected stars filesystem error to be returned")
	}
}

func TestNoteSaveContinuesAfterRemovingCorruptStars(t *testing.T) {
	dir := t.TempDir()
	notePath := filepath.Join(dir, "Plan.md")
	if err := os.WriteFile(notePath, []byte("original"), 0o644); err != nil {
		t.Fatalf("write note failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".stars.json"), []byte("{"), 0o644); err != nil {
		t.Fatalf("write stars file failed: %v", err)
	}

	s := &Server{}
	if _, _, err := s.saveNote(dir, "Plan", "", "updated"); err != nil {
		t.Fatalf("save note failed: %v", err)
	}

	content, err := os.ReadFile(notePath)
	if err != nil {
		t.Fatalf("read note failed: %v", err)
	}
	if string(content) != "updated" {
		t.Fatalf("expected note to be updated, got %q", content)
	}
}

func TestStarRequiresExistingNote(t *testing.T) {
	notesBaseDir := t.TempDir()
	userDir := filepath.Join(notesBaseDir, "david")
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatalf("create user notes directory failed: %v", err)
	}

	s := &Server{
		notesBaseDir: notesBaseDir,
		sessions: map[string]Session{
			"sid": {
				User:      SessionUser{Username: "david", DisplayName: "David"},
				ExpiresAt: time.Now().Add(time.Hour),
			},
		},
		hub: NewHub(),
	}

	req := httptest.NewRequest(http.MethodPut, "/client-api/notes/Missing/star", strings.NewReader(`{"starred":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "sid"})
	w := httptest.NewRecorder()

	s.handleNoteByTitle(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected missing note star request to return 404, got %d body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(userDir, ".stars.json")); !os.IsNotExist(err) {
		t.Fatalf("expected no stars file to be written, stat error=%v", err)
	}
}

func TestConcurrentStarUpdatesArePreserved(t *testing.T) {
	dir := t.TempDir()
	s := &Server{}
	keys := []string{"one", "two", "three", "four", "five"}

	var wg sync.WaitGroup
	for _, key := range keys {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.setNoteStarred(dir, key, true); err != nil {
				t.Errorf("star %q failed: %v", key, err)
			}
		}()
	}
	wg.Wait()

	stars, err := loadStars(dir)
	if err != nil {
		t.Fatalf("load stars failed: %v", err)
	}
	for _, key := range keys {
		if !stars[key] {
			t.Errorf("expected %q to remain starred", key)
		}
	}
}

func TestJSONResponsesDisableCaching(t *testing.T) {
	w := httptest.NewRecorder()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})

	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected Cache-Control no-store, got %q", got)
	}
}
