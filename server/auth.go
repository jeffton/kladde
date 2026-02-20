package main

import (
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	var payload struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSONBody(w, r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	username := strings.TrimSpace(payload.Username)
	password := strings.TrimSpace(payload.Password)
	if username == "" || password == "" {
		writeError(w, http.StatusBadRequest, errors.New("username and password are required"))
		return
	}

	users, err := loadUsers(s.usersFile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, errors.New("failed loading users"))
		return
	}

	var matched *UserRecord
	for i := range users {
		if users[i].Username == username {
			matched = &users[i]
			break
		}
	}

	if matched == nil || bcrypt.CompareHashAndPassword([]byte(matched.PasswordHash), []byte(password)) != nil {
		writeError(w, http.StatusUnauthorized, errors.New("invalid credentials"))
		return
	}

	user := SessionUser{Username: matched.Username, DisplayName: matched.DisplayName}
	if err := os.MkdirAll(s.userNotesDir(user.Username), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, errors.New("failed to prepare user notes directory"))
		return
	}

	sessionID, err := randomToken(48)
	if err != nil {
		writeError(w, http.StatusInternalServerError, errors.New("failed creating session"))
		return
	}

	expiresAt := time.Now().Add(30 * 24 * time.Hour)
	s.sessionsMu.Lock()
	s.sessions[sessionID] = Session{User: user, ExpiresAt: expiresAt}
	s.sessionsMu.Unlock()

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sessionID,
		Path:     "/",
		Expires:  expiresAt,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})

	writeJSON(w, http.StatusOK, user)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
		s.sessionsMu.Lock()
		delete(s.sessions, cookie.Value)
		s.sessionsMu.Unlock()
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})

	writeJSON(w, http.StatusOK, map[string]string{"status": "logged out"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	session, ok := s.requireAuth(w, r)
	if !ok {
		return
	}

	writeJSON(w, http.StatusOK, session.User)
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	session, ok := s.requireAuth(w, r)
	if !ok {
		return
	}

	var payload struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := decodeJSONBody(w, r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	currentPassword := strings.TrimSpace(payload.CurrentPassword)
	newPassword := strings.TrimSpace(payload.NewPassword)
	if currentPassword == "" || newPassword == "" {
		writeError(w, http.StatusBadRequest, errors.New("currentPassword and newPassword are required"))
		return
	}

	s.usersMu.Lock()
	defer s.usersMu.Unlock()

	users, err := loadUsers(s.usersFile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, errors.New("failed loading users"))
		return
	}

	matchedIndex := -1
	for i := range users {
		if users[i].Username == session.User.Username {
			matchedIndex = i
			break
		}
	}
	if matchedIndex < 0 {
		writeError(w, http.StatusUnauthorized, errors.New("unauthorized"))
		return
	}

	if bcrypt.CompareHashAndPassword([]byte(users[matchedIndex].PasswordHash), []byte(currentPassword)) != nil {
		writeError(w, http.StatusUnauthorized, errors.New("current password is incorrect"))
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, errors.New("failed hashing password"))
		return
	}

	users[matchedIndex].PasswordHash = string(hash)
	if err := saveUsers(s.usersFile, users); err != nil {
		writeError(w, http.StatusInternalServerError, errors.New("failed saving password"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) requireAuth(w http.ResponseWriter, r *http.Request) (Session, bool) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		writeError(w, http.StatusUnauthorized, errors.New("unauthorized"))
		return Session{}, false
	}

	now := time.Now()
	s.sessionsMu.RLock()
	session, ok := s.sessions[cookie.Value]
	s.sessionsMu.RUnlock()
	if !ok || now.After(session.ExpiresAt) {
		if ok {
			s.sessionsMu.Lock()
			delete(s.sessions, cookie.Value)
			s.sessionsMu.Unlock()
		}
		writeError(w, http.StatusUnauthorized, errors.New("unauthorized"))
		return Session{}, false
	}

	return session, true
}
