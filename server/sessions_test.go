package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func sessionTestServer(t *testing.T, dir string) *Server {
	t.Helper()
	s := &Server{
		sessionsFile: filepath.Join(dir, "sessions.json"),
		usersFile:    filepath.Join(dir, "users.json"),
		notesBaseDir: filepath.Join(dir, "notes"),
	}
	if err := s.loadSessions(); err != nil {
		t.Fatal(err)
	}
	return s
}

func sessionRequest(s *Server, cookie *http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/client-api/me", nil)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()
	s.handleMe(w, req)
	return w
}

func TestLoginSurvivesRestartAndLogoutPersists(t *testing.T) {
	dir := t.TempDir()
	s := sessionTestServer(t, dir)
	hash, err := bcrypt.GenerateFromPassword([]byte("test-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveUsers(s.usersFile, []UserRecord{{Username: "test", DisplayName: "Test", PasswordHash: string(hash)}}); err != nil {
		t.Fatal(err)
	}
	before := time.Now()
	w := httptest.NewRecorder()
	s.handleAuthLogin(w, httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader(`{"username":"test","password":"test-password"}`)))
	if w.Code != http.StatusOK {
		t.Fatalf("login status: %d", w.Code)
	}
	cookie := w.Result().Cookies()[0]
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatal("login cookie protections changed")
	}
	original := s.sessions[cookie.Value]
	if original.ExpiresAt.Before(before.Add(30*24*time.Hour)) || original.ExpiresAt.After(time.Now().Add(30*24*time.Hour)) {
		t.Fatal("login lifetime changed")
	}
	info, err := os.Stat(s.sessionsFile)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("session permissions: %o", info.Mode().Perm())
	}

	s = sessionTestServer(t, dir)
	if w := sessionRequest(s, cookie); w.Code != http.StatusOK {
		t.Fatalf("session after restart: %d", w.Code)
	} else {
		var user SessionUser
		if err := json.Unmarshal(w.Body.Bytes(), &user); err != nil || user.Username != "test" {
			t.Fatal("session user not preserved")
		}
	}
	if !s.sessions[cookie.Value].ExpiresAt.Equal(original.ExpiresAt) {
		t.Fatal("restart changed expiry")
	}
	logout := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	logout.AddCookie(cookie)
	w = httptest.NewRecorder()
	s.handleLogout(w, logout)
	if w.Code != http.StatusOK || w.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("logout did not clear cookie")
	}
	s = sessionTestServer(t, dir)
	if w := sessionRequest(s, cookie); w.Code != http.StatusUnauthorized {
		t.Fatalf("logged out session revived after restart: %d", w.Code)
	}
}

func TestExpiredSessionsRejectedBeforeAndAfterRestart(t *testing.T) {
	dir := t.TempDir()
	s := sessionTestServer(t, dir)
	if err := s.storeSession("expired", Session{User: SessionUser{Username: "test"}, ExpiresAt: time.Now().Add(-time.Minute)}); err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: sessionCookieName, Value: "expired"}
	if w := sessionRequest(s, cookie); w.Code != http.StatusUnauthorized {
		t.Fatalf("expired session accepted: %d", w.Code)
	}
	s = sessionTestServer(t, dir)
	if len(s.sessions) != 0 {
		t.Fatal("startup retained expired sessions")
	}
	if w := sessionRequest(s, cookie); w.Code != http.StatusUnauthorized {
		t.Fatalf("expired session revived after restart: %d", w.Code)
	}
}

func TestSessionPersistenceErrors(t *testing.T) {
	t.Run("invalid file prevents startup", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "sessions.json")
		if err := os.WriteFile(path, []byte("{invalid"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := (&Server{sessionsFile: path}).loadSessions(); err == nil {
			t.Fatal("corrupt sessions silently ignored")
		}
	})
	t.Run("failed logout preserves memory and returns error", func(t *testing.T) {
		s := sessionTestServer(t, t.TempDir())
		session := Session{User: SessionUser{Username: "test"}, ExpiresAt: time.Now().Add(time.Hour)}
		if err := s.storeSession("active", session); err != nil {
			t.Fatal(err)
		}
		// Renaming a file onto a directory must fail even when tests run as root.
		s.sessionsFile = t.TempDir()
		req := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "active"})
		w := httptest.NewRecorder()
		s.handleLogout(w, req)
		if w.Code != http.StatusInternalServerError || len(w.Result().Cookies()) != 0 {
			t.Fatal("logout claimed success despite failed persistence")
		}
		if _, ok := s.sessions["active"]; !ok {
			t.Fatal("failed persistence changed memory")
		}
		if err := s.storeSession("new", session); err == nil {
			t.Fatal("write failure was hidden")
		}
		if _, ok := s.sessions["new"]; ok {
			t.Fatal("failed persistence installed a session")
		}
	})
}

func TestConcurrentSessionChangesSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	s := sessionTestServer(t, dir)
	var wg sync.WaitGroup
	for _, id := range []string{"one", "two", "three", "four"} {
		wg.Go(func() {
			if err := s.storeSession(id, Session{User: SessionUser{Username: "test"}, ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	s = sessionTestServer(t, dir)
	if len(s.sessions) != 4 {
		t.Fatalf("concurrent write lost sessions: %d", len(s.sessions))
	}
}
