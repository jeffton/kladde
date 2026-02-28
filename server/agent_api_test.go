package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func makeAgentTestServer(t *testing.T, readOnly bool) (*Server, string, string) {
	t.Helper()

	dir := t.TempDir()
	notesDir := filepath.Join(dir, "notes")
	if err := os.MkdirAll(notesDir, 0o755); err != nil {
		t.Fatalf("mkdir notes failed: %v", err)
	}

	apiKeysFile := filepath.Join(dir, "apikeys.json")
	secret := "super-secret-token"
	hash, err := bcrypt.GenerateFromPassword([]byte(secret), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("hash api key failed: %v", err)
	}

	username := "david"
	if err := saveAPIKeys(apiKeysFile, []APIKeyRecord{{
		ID:           "agent-1",
		Name:         "test-agent",
		Username:     username,
		PasswordHash: string(hash),
		ReadOnly:     readOnly,
	}}); err != nil {
		t.Fatalf("save api keys failed: %v", err)
	}

	s := &Server{
		notesBaseDir: notesDir,
		apiKeysFile:  apiKeysFile,
		hub:          NewHub(),
	}

	return s, "kld_agent-1." + secret, username
}

func authRequest(method, path, token string, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	return req
}

func TestHandleAgentAPIPublicDocumentation(t *testing.T) {
	s, _, _ := makeAgentTestServer(t, false)

	req := httptest.NewRequest(http.MethodGet, "/api", nil)
	w := httptest.NewRecorder()
	s.handleAgentAPI(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", w.Code, w.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("parse docs payload failed: %v", err)
	}

	if payload["auth"] == "" {
		t.Fatal("expected auth field in /api docs")
	}

	endpoints, ok := payload["endpoints"].(map[string]any)
	if !ok {
		t.Fatalf("expected endpoints map, got %#v", payload["endpoints"])
	}
	if _, found := endpoints["PATCH /api/notes/{path}"]; !found {
		t.Fatalf("expected PATCH endpoint in docs, got %#v", endpoints)
	}
}

func TestAgentAPIRequiresAuthForNotesList(t *testing.T) {
	s, _, _ := makeAgentTestServer(t, false)

	req := httptest.NewRequest(http.MethodGet, "/api/notes", nil)
	w := httptest.NewRecorder()
	s.handleAgentNotes(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestAgentAPIPutAndGetMarkdown(t *testing.T) {
	s, token, username := makeAgentTestServer(t, false)

	putReq := authRequest(http.MethodPut, "/api/notes/opskrifter/carbonara", token, "# Carbonara\n\n- Æg")
	putW := httptest.NewRecorder()
	s.handleAgentNoteByPath(putW, putReq)
	if putW.Code != http.StatusCreated {
		t.Fatalf("expected PUT 201, got %d body=%s", putW.Code, putW.Body.String())
	}
	if !strings.Contains(putW.Header().Get("Content-Type"), "text/markdown") {
		t.Fatalf("expected markdown response, got %q", putW.Header().Get("Content-Type"))
	}

	notePath := filepath.Join(s.userNotesDir(username), "opskrifter", "carbonara.md")
	if _, err := os.Stat(notePath); err != nil {
		t.Fatalf("expected note on disk, stat failed: %v", err)
	}

	getReq := authRequest(http.MethodGet, "/api/notes/opskrifter/carbonara", token, "")
	getW := httptest.NewRecorder()
	s.handleAgentNoteByPath(getW, getReq)
	if getW.Code != http.StatusOK {
		t.Fatalf("expected GET 200, got %d body=%s", getW.Code, getW.Body.String())
	}
	if body := getW.Body.String(); body != "# Carbonara\n\n- Æg" {
		t.Fatalf("unexpected markdown body: %q", body)
	}
}

func TestAgentAPIPatchRequiresSingleMatch(t *testing.T) {
	s, token, _ := makeAgentTestServer(t, false)
	userDir := s.userNotesDir("david")

	if _, _, err := s.saveNote(userDir, "Indkøb", "", "## Frugt\n- Æbler\n"); err != nil {
		t.Fatalf("seed note failed: %v", err)
	}

	patchReq := authRequest(http.MethodPatch, "/api/notes/Indk%C3%B8b", token, `{"find":"- Æbler","replace":"- Æbler\n- Bananer"}`)
	patchReq.Header.Set("Content-Type", "application/json")
	patchW := httptest.NewRecorder()
	s.handleAgentNoteByPath(patchW, patchReq)
	if patchW.Code != http.StatusOK {
		t.Fatalf("expected PATCH 200, got %d body=%s", patchW.Code, patchW.Body.String())
	}
	if !strings.Contains(patchW.Body.String(), "- Bananer") {
		t.Fatalf("expected replacement in response, got %q", patchW.Body.String())
	}

	if _, _, err := s.saveNote(userDir, "Dublet", "", "x\nmidte\nx\n"); err != nil {
		t.Fatalf("seed duplicate note failed: %v", err)
	}
	multiReq := authRequest(http.MethodPatch, "/api/notes/Dublet", token, `{"find":"x","replace":"y"}`)
	multiReq.Header.Set("Content-Type", "application/json")
	multiW := httptest.NewRecorder()
	s.handleAgentNoteByPath(multiW, multiReq)
	if multiW.Code != http.StatusConflict {
		t.Fatalf("expected PATCH conflict for multi-match, got %d body=%s", multiW.Code, multiW.Body.String())
	}

	zeroReq := authRequest(http.MethodPatch, "/api/notes/Indk%C3%B8b", token, `{"find":"- Kiwi","replace":"- Kiwi\n- Pære"}`)
	zeroReq.Header.Set("Content-Type", "application/json")
	zeroW := httptest.NewRecorder()
	s.handleAgentNoteByPath(zeroW, zeroReq)
	if zeroW.Code != http.StatusConflict {
		t.Fatalf("expected PATCH conflict for zero-match, got %d body=%s", zeroW.Code, zeroW.Body.String())
	}
}

func TestAgentAPISearchReturnsLineMatches(t *testing.T) {
	s, token, _ := makeAgentTestServer(t, false)
	userDir := s.userNotesDir("david")

	if _, _, err := s.saveNote(userDir, "Indkøb", "", "## Frugt\n- Bananer\n- Æbler\n"); err != nil {
		t.Fatalf("seed first note failed: %v", err)
	}
	if _, _, err := s.saveNote(userDir, "Opskrift", "mad", "Bananer i kage\n"); err != nil {
		t.Fatalf("seed second note failed: %v", err)
	}

	req := authRequest(http.MethodGet, "/api/search?q=bananer", token, "")
	w := httptest.NewRecorder()
	s.handleAgentSearch(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected search 200, got %d body=%s", w.Code, w.Body.String())
	}

	var results []AgentSearchResult
	if err := json.Unmarshal(w.Body.Bytes(), &results); err != nil {
		t.Fatalf("parse search response failed: %v", err)
	}
	if len(results) < 2 {
		t.Fatalf("expected >=2 results, got %d payload=%s", len(results), w.Body.String())
	}

	foundLine := false
	for _, result := range results {
		for _, match := range result.Matches {
			if match.Line == 2 && strings.Contains(match.Text, "Bananer") {
				foundLine = true
			}
		}
	}
	if !foundLine {
		t.Fatalf("expected line-numbered match for '- Bananer', got %s", w.Body.String())
	}
}

func TestAgentAPIReadOnlyKeyBlocksWrites(t *testing.T) {
	s, token, _ := makeAgentTestServer(t, true)
	userDir := s.userNotesDir("david")
	if _, _, err := s.saveNote(userDir, "Plan", "", "før"); err != nil {
		t.Fatalf("seed note failed: %v", err)
	}

	putReq := authRequest(http.MethodPut, "/api/notes/Plan", token, "efter")
	putW := httptest.NewRecorder()
	s.handleAgentNoteByPath(putW, putReq)
	if putW.Code != http.StatusForbidden {
		t.Fatalf("expected PUT 403 for readonly key, got %d body=%s", putW.Code, putW.Body.String())
	}

	patchReq := authRequest(http.MethodPatch, "/api/notes/Plan", token, `{"find":"før","replace":"efter"}`)
	patchReq.Header.Set("Content-Type", "application/json")
	patchW := httptest.NewRecorder()
	s.handleAgentNoteByPath(patchW, patchReq)
	if patchW.Code != http.StatusForbidden {
		t.Fatalf("expected PATCH 403 for readonly key, got %d body=%s", patchW.Code, patchW.Body.String())
	}

	deleteReq := authRequest(http.MethodDelete, "/api/notes/Plan", token, "")
	deleteW := httptest.NewRecorder()
	s.handleAgentNoteByPath(deleteW, deleteReq)
	if deleteW.Code != http.StatusForbidden {
		t.Fatalf("expected DELETE 403 for readonly key, got %d body=%s", deleteW.Code, deleteW.Body.String())
	}
}

func TestRunAddAPIKeyCreatesHashedKey(t *testing.T) {
	dir := t.TempDir()
	keysFile := filepath.Join(dir, "apikeys.json")

	if err := runAddAPIKey([]string{
		"--username", "david",
		"--name", "bot",
		"--keys", keysFile,
		"--readonly",
	}); err != nil {
		t.Fatalf("runAddAPIKey failed: %v", err)
	}

	keys, err := loadAPIKeys(keysFile)
	if err != nil {
		t.Fatalf("loadAPIKeys failed: %v", err)
	}
	if len(keys) != 1 {
		t.Fatalf("expected 1 key, got %d", len(keys))
	}
	if keys[0].Username != "david" || keys[0].Name != "bot" || !keys[0].ReadOnly {
		t.Fatalf("unexpected key fields: %+v", keys[0])
	}
	if keys[0].PasswordHash == "" {
		t.Fatalf("expected password hash to be set")
	}
}
