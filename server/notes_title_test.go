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

func TestNoteTitleSlashes(t *testing.T) {
	for _, operation := range []string{"create", "rename"} {
		for _, tc := range []struct {
			name string
			raw  string
			want string
		}{
			{"stripped", " /Plan/idéer/ ", "Planidéer"},
			{"collision", "Ex/isting", "Existing (2)"},
			{"empty", " / / ", ""},
		} {
			t.Run(operation+"/"+tc.name, func(t *testing.T) {
				s := &Server{
					notesBaseDir: t.TempDir(),
					sessions: map[string]Session{"sid": {
						User:      SessionUser{Username: "tester"},
						ExpiresAt: time.Now().Add(time.Hour),
					}},
					hub: NewHub(),
				}
				dir := s.userNotesDir("tester")
				for _, title := range []string{"Existing", "Original"} {
					if _, _, err := s.saveNote(dir, title, "Plans", "unchanged"); err != nil {
						t.Fatal(err)
					}
				}

				method, path := http.MethodPost, "/client-api/notes"
				payload := map[string]string{"title": tc.raw, "collection": "Plans", "content": "unchanged"}
				handler := s.handleNotes
				if operation == "rename" {
					method, path = http.MethodPut, "/client-api/notes/Original/rename?collection=Plans"
					payload = map[string]string{"newTitle": tc.raw}
					handler = s.handleNoteByTitle
				}
				body, err := json.Marshal(payload)
				if err != nil {
					t.Fatal(err)
				}
				req := httptest.NewRequest(method, path, strings.NewReader(string(body)))
				req.Header.Set("Content-Type", "application/json")
				req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "sid"})
				w := httptest.NewRecorder()
				handler(w, req)
				if tc.want == "" {
					if w.Code != http.StatusBadRequest {
						t.Fatalf("expected 400 for empty sanitized title, got %d: %s", w.Code, w.Body.String())
					}
				} else {
					wantStatus := http.StatusCreated
					if operation == "rename" {
						wantStatus = http.StatusOK
					}
					if w.Code != wantStatus {
						t.Fatalf("status %d: %s", w.Code, w.Body.String())
					}
					var note Note
					if err := json.Unmarshal(w.Body.Bytes(), &note); err != nil {
						t.Fatal(err)
					}
					if note.Title != tc.want || note.Key != "Plans/"+tc.want || note.Collection != "Plans" {
						t.Fatalf("unexpected note identity: %+v", note)
					}
					content, err := os.ReadFile(filepath.Join(dir, "Plans", tc.want+".md"))
					if err != nil || string(content) != "unchanged" {
						t.Fatalf("title/filename/content mismatch: %q, %v", content, err)
					}
				}
				content, err := os.ReadFile(filepath.Join(dir, "Plans", "Existing.md"))
				if err != nil || string(content) != "unchanged" {
					t.Fatalf("existing note changed: %q, %v", content, err)
				}
				if tc.want == "" {
					if _, err := os.Stat(filepath.Join(dir, "Plans", "Original.md")); err != nil {
						t.Fatalf("rejected rename changed original: %v", err)
					}
				}
			})
		}
	}
}
