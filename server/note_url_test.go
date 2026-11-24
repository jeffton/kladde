package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNoteURLDistinguishesPercentEscapesFromSeparators(t *testing.T) {
	s, token, username := makeAgentTestServer(t, false)
	s.sessions = map[string]Session{"sid": {
		User:      SessionUser{Username: username},
		ExpiresAt: time.Now().Add(time.Hour),
	}}
	mux := http.NewServeMux()
	mux.HandleFunc("/client-api/notes/", s.handleNoteByTitle)
	mux.HandleFunc("/api/notes/", s.handleAgentNoteByPath)
	dir := s.userNotesDir(username)
	for _, note := range []struct {
		title      string
		collection string
	}{
		{"Plan 100%", ""},
		{"Plan%20draft", ""},
		{"Plan draft", ""},
		{"Plan", "Work%202"},
		{"Plan", "Work 2"},
	} {
		if _, _, err := s.saveNote(dir, note.title, note.collection, note.title+note.collection); err != nil {
			t.Fatal(err)
		}
	}

	for _, tc := range []struct {
		path   string
		status int
		want   string
	}{
		{"/client-api/notes/Plan%20100%25", http.StatusOK, "Plan 100%"},
		{"/client-api/notes/Plan%2520draft", http.StatusOK, "Plan%20draft"},
		{"/client-api/notes/Plan%2Fshare", http.StatusBadRequest, ""},
		{"/api/notes/Plan%2520draft", http.StatusOK, "Plan%20draft"},
		{"/api/notes/Work%25202/Plan", http.StatusOK, "PlanWork%202"},
		{"/api/notes/Work%202%2FPlan", http.StatusBadRequest, ""},
	} {
		t.Run(tc.path, func(t *testing.T) {
			req := authRequest(http.MethodGet, tc.path, token, "")
			req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "sid"})
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Fatalf("got status %d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
			if tc.status != http.StatusOK {
				return
			}
			got := w.Body.String()
			if w.Header().Get("Content-Type") == "application/json" {
				var note Note
				if err := json.Unmarshal(w.Body.Bytes(), &note); err != nil {
					t.Fatal(err)
				}
				got = note.Content
			}
			if got != tc.want {
				t.Fatalf("got content %q, want %q", got, tc.want)
			}
		})
	}
}
