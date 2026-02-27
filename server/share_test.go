package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCreateShareReplacesExistingTokenForMode(t *testing.T) {
	dir := t.TempDir()
	sharesFile := filepath.Join(dir, "shares.json")

	s := &Server{
		sharesFile: sharesFile,
		shares:     map[string]ShareRecord{},
	}

	if err := s.loadShares(); err != nil {
		t.Fatalf("loadShares failed: %v", err)
	}

	file := shareFileRef("david", "Plan", "arbejde")
	first, err := s.createShare(file, shareModeEdit)
	if err != nil {
		t.Fatalf("createShare first failed: %v", err)
	}
	if first == "" {
		t.Fatal("expected first share token")
	}

	second, err := s.createShare(file, shareModeEdit)
	if err != nil {
		t.Fatalf("createShare second failed: %v", err)
	}
	if second == "" || second == first {
		t.Fatalf("expected second token to replace first, got first=%q second=%q", first, second)
	}

	if _, ok := s.findShare(first); ok {
		t.Fatal("old token should have been removed")
	}

	record, ok := s.findShare(second)
	if !ok {
		t.Fatal("new token not found")
	}
	if record.File != file || record.Mode != shareModeEdit {
		t.Fatalf("unexpected record: %+v", record)
	}

	raw, err := os.ReadFile(sharesFile)
	if err != nil {
		t.Fatalf("read shares file failed: %v", err)
	}
	var payload map[string]ShareRecord
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("parse shares file failed: %v", err)
	}
	if len(payload) != 1 {
		t.Fatalf("expected 1 share in file, got %d", len(payload))
	}
}

func TestHandleSharePageServesSPAForReadonlyToken(t *testing.T) {
	dir := t.TempDir()
	clientDir := filepath.Join(dir, "client")
	if err := os.MkdirAll(clientDir, 0o755); err != nil {
		t.Fatalf("mkdir client failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(clientDir, "index.html"), []byte("<html><body>kladde app</body></html>"), 0o644); err != nil {
		t.Fatalf("write index failed: %v", err)
	}

	token := "readonlytoken"
	s := &Server{
		clientDir: clientDir,
		shares: map[string]ShareRecord{
			token: {
				File:    shareFileRef("david", "Opskrift", ""),
				Mode:    shareModeView,
				Created: "2026-02-26T21:00:00Z",
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/share/"+token, nil)
	w := httptest.NewRecorder()
	s.handleSharePage(w, req)

	res := w.Result()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	if !strings.Contains(w.Body.String(), "kladde app") {
		t.Fatalf("expected SPA index in body, got: %s", w.Body.String())
	}
}

func TestHandleSharedNoteAPIViewTokenIsReadonly(t *testing.T) {
	dir := t.TempDir()
	notesDir := filepath.Join(dir, "notes")
	if err := os.MkdirAll(filepath.Join(notesDir, "david"), 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	notePath := filepath.Join(notesDir, "david", "Plan.md")
	if err := os.WriteFile(notePath, []byte("før"), 0o644); err != nil {
		t.Fatalf("write note failed: %v", err)
	}

	token := "viewtoken"
	s := &Server{
		notesBaseDir: notesDir,
		shares: map[string]ShareRecord{
			token: {
				File:    shareFileRef("david", "Plan", ""),
				Mode:    shareModeView,
				Created: "2026-02-26T21:00:00Z",
			},
		},
		hub: NewHub(),
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/share/"+token+"/note", nil)
	getW := httptest.NewRecorder()
	s.handleSharedNoteAPI(getW, getReq)
	if getW.Code != http.StatusOK {
		t.Fatalf("expected GET 200, got %d body=%s", getW.Code, getW.Body.String())
	}

	var getPayload map[string]any
	if err := json.Unmarshal(getW.Body.Bytes(), &getPayload); err != nil {
		t.Fatalf("parse GET payload failed: %v", err)
	}
	if mode, _ := getPayload["shareMode"].(string); mode != shareModeView {
		t.Fatalf("expected shareMode=%q, got %q", shareModeView, mode)
	}

	putReq := httptest.NewRequest(http.MethodPut, "/api/share/"+token+"/note", strings.NewReader(`{"content":"efter"}`))
	putReq.Header.Set("Content-Type", "application/json")
	putW := httptest.NewRecorder()
	s.handleSharedNoteAPI(putW, putReq)
	if putW.Code != http.StatusForbidden {
		t.Fatalf("expected PUT 403 for readonly share, got %d body=%s", putW.Code, putW.Body.String())
	}
}

func TestHandleSharedNoteAPIGetAndPutForEditToken(t *testing.T) {
	dir := t.TempDir()
	notesDir := filepath.Join(dir, "notes")
	if err := os.MkdirAll(filepath.Join(notesDir, "david"), 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	notePath := filepath.Join(notesDir, "david", "Plan.md")
	if err := os.WriteFile(notePath, []byte("før"), 0o644); err != nil {
		t.Fatalf("write note failed: %v", err)
	}

	token := "edittoken"
	s := &Server{
		notesBaseDir: notesDir,
		shares: map[string]ShareRecord{
			token: {
				File:    shareFileRef("david", "Plan", ""),
				Mode:    shareModeEdit,
				Created: "2026-02-26T21:00:00Z",
			},
		},
		hub: NewHub(),
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/share/"+token+"/note", nil)
	getW := httptest.NewRecorder()
	s.handleSharedNoteAPI(getW, getReq)
	if getW.Code != http.StatusOK {
		t.Fatalf("expected GET 200, got %d body=%s", getW.Code, getW.Body.String())
	}

	var getPayload map[string]any
	if err := json.Unmarshal(getW.Body.Bytes(), &getPayload); err != nil {
		t.Fatalf("parse GET payload failed: %v", err)
	}
	if mode, _ := getPayload["shareMode"].(string); mode != shareModeEdit {
		t.Fatalf("expected shareMode=%q, got %q", shareModeEdit, mode)
	}

	putReq := httptest.NewRequest(http.MethodPut, "/api/share/"+token+"/note", strings.NewReader(`{"content":"efter"}`))
	putReq.Header.Set("Content-Type", "application/json")
	putW := httptest.NewRecorder()
	s.handleSharedNoteAPI(putW, putReq)
	if putW.Code != http.StatusOK {
		t.Fatalf("expected PUT 200, got %d body=%s", putW.Code, putW.Body.String())
	}

	updated, err := os.ReadFile(notePath)
	if err != nil {
		t.Fatalf("read updated note failed: %v", err)
	}
	if string(updated) != "efter" {
		t.Fatalf("expected updated content, got %q", string(updated))
	}
}

func TestShareTokenSurvivesRenameAndCollectionMoves(t *testing.T) {
	dir := t.TempDir()
	notesDir := filepath.Join(dir, "notes")
	if err := os.MkdirAll(filepath.Join(notesDir, "david"), 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "david", "Plan.md"), []byte("før"), 0o644); err != nil {
		t.Fatalf("write note failed: %v", err)
	}

	token := "renamesharetoken"
	s := &Server{
		notesBaseDir: notesDir,
		sharesFile:   filepath.Join(dir, "shares.json"),
		shares: map[string]ShareRecord{
			token: {
				File:    shareFileRef("david", "Plan", ""),
				Mode:    shareModeEdit,
				Created: "2026-02-26T21:00:00Z",
			},
		},
		sessions: map[string]Session{
			"sid": {
				User:      SessionUser{Username: "david", DisplayName: "David"},
				ExpiresAt: time.Now().Add(time.Hour),
			},
		},
		hub: NewHub(),
	}

	s.sharesMu.Lock()
	if err := s.persistSharesLocked(); err != nil {
		s.sharesMu.Unlock()
		t.Fatalf("persist initial shares failed: %v", err)
	}
	s.sharesMu.Unlock()

	renameToCollectionReq := httptest.NewRequest(
		http.MethodPut,
		"/api/notes/Plan/rename",
		strings.NewReader(`{"newTitle":"Plan flyttet","newCollection":"arbejde"}`),
	)
	renameToCollectionReq.Header.Set("Content-Type", "application/json")
	renameToCollectionReq.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "sid"})

	renameToCollectionW := httptest.NewRecorder()
	s.handleNoteByTitle(renameToCollectionW, renameToCollectionReq)
	if renameToCollectionW.Code != http.StatusOK {
		t.Fatalf("expected rename into collection 200, got %d body=%s", renameToCollectionW.Code, renameToCollectionW.Body.String())
	}

	sharedAfterMoveReq := httptest.NewRequest(http.MethodGet, "/api/share/"+token+"/note", nil)
	sharedAfterMoveW := httptest.NewRecorder()
	s.handleSharedNoteAPI(sharedAfterMoveW, sharedAfterMoveReq)
	if sharedAfterMoveW.Code != http.StatusOK {
		t.Fatalf("expected shared GET after move 200, got %d body=%s", sharedAfterMoveW.Code, sharedAfterMoveW.Body.String())
	}

	var movedPayload map[string]any
	if err := json.Unmarshal(sharedAfterMoveW.Body.Bytes(), &movedPayload); err != nil {
		t.Fatalf("parse shared payload after move failed: %v", err)
	}
	if title, _ := movedPayload["title"].(string); title != "Plan flyttet" {
		t.Fatalf("expected moved title %q, got %q", "Plan flyttet", title)
	}
	if collection, _ := movedPayload["collection"].(string); collection != "arbejde" {
		t.Fatalf("expected moved collection %q, got %q", "arbejde", collection)
	}

	renameOutOfCollectionReq := httptest.NewRequest(
		http.MethodPut,
		"/api/notes/Plan%20flyttet/rename?collection=arbejde",
		strings.NewReader(`{"newTitle":"Plan igen","newCollection":""}`),
	)
	renameOutOfCollectionReq.Header.Set("Content-Type", "application/json")
	renameOutOfCollectionReq.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "sid"})

	renameOutOfCollectionW := httptest.NewRecorder()
	s.handleNoteByTitle(renameOutOfCollectionW, renameOutOfCollectionReq)
	if renameOutOfCollectionW.Code != http.StatusOK {
		t.Fatalf("expected rename out of collection 200, got %d body=%s", renameOutOfCollectionW.Code, renameOutOfCollectionW.Body.String())
	}

	sharedAfterMoveBackReq := httptest.NewRequest(http.MethodGet, "/api/share/"+token+"/note", nil)
	sharedAfterMoveBackW := httptest.NewRecorder()
	s.handleSharedNoteAPI(sharedAfterMoveBackW, sharedAfterMoveBackReq)
	if sharedAfterMoveBackW.Code != http.StatusOK {
		t.Fatalf("expected shared GET after move back 200, got %d body=%s", sharedAfterMoveBackW.Code, sharedAfterMoveBackW.Body.String())
	}

	var movedBackPayload map[string]any
	if err := json.Unmarshal(sharedAfterMoveBackW.Body.Bytes(), &movedBackPayload); err != nil {
		t.Fatalf("parse shared payload after move back failed: %v", err)
	}
	if title, _ := movedBackPayload["title"].(string); title != "Plan igen" {
		t.Fatalf("expected moved-back title %q, got %q", "Plan igen", title)
	}
	if collection, _ := movedBackPayload["collection"].(string); collection != "" {
		t.Fatalf("expected moved-back collection to be empty, got %q", collection)
	}
}
