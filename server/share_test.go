package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
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

func TestHandleSharePageReadonlyRendersHTML(t *testing.T) {
	dir := t.TempDir()
	notesDir := filepath.Join(dir, "notes")
	if err := os.MkdirAll(filepath.Join(notesDir, "david"), 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}

	notePath := filepath.Join(notesDir, "david", "Opskrift.md")
	if err := os.WriteFile(notePath, []byte("# Suppe\n\n- Gulerødder\n"), 0o644); err != nil {
		t.Fatalf("write note failed: %v", err)
	}

	token := "readonlytoken"
	s := &Server{
		notesBaseDir: notesDir,
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

	body := w.Body.String()
	if !strings.Contains(body, "Kopiér som markdown") {
		t.Fatalf("expected copy button in body, got: %s", body)
	}
	if !strings.Contains(body, "<h1>Opskrift</h1>") {
		t.Fatalf("expected note title in rendered HTML, got: %s", body)
	}
}

func TestHandleSharedNoteAPIGetAndPut(t *testing.T) {
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
