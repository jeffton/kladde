package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/crypto/bcrypt"
)

const maxJSONBodySize = 1 << 20 // 1MB
const maxTitleLength = 200

const sessionCookieName = "kladde_session"

type NoteMeta struct {
	Title     string    `json:"title"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Note struct {
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type SessionUser struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

type UserRecord struct {
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
	DisplayName  string `json:"displayName"`
}

type Session struct {
	User      SessionUser
	ExpiresAt time.Time
}

type Server struct {
	notesBaseDir string
	distDir      string
	usersFile    string
	sessions     map[string]Session
	sessionsMu   sync.RWMutex
	usersMu      sync.Mutex
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "adduser" {
		if err := runAddUser(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
		return
	}

	addr := flag.String("addr", ":8080", "HTTP listen address")
	notesDir := flag.String("notes", "/var/data/kladde/notes/", "Path to notes directory")
	distDir := flag.String("dist", "../client/dist", "Path to built client dist directory")
	usersFile := flag.String("users", "/var/data/kladde/users.json", "Path to users.json")
	flag.Parse()

	if err := os.MkdirAll(*notesDir, 0o755); err != nil {
		log.Fatalf("failed creating notes dir: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(*usersFile), 0o755); err != nil {
		log.Fatalf("failed creating users dir: %v", err)
	}

	s := &Server{
		notesBaseDir: *notesDir,
		distDir:      *distDir,
		usersFile:    *usersFile,
		sessions:     make(map[string]Session),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", s.handleAuthLogin)
	mux.HandleFunc("/auth/logout", s.handleLogout)
	mux.HandleFunc("/api/me", s.handleMe)
	mux.HandleFunc("/api/me/password", s.handleChangePassword)
	mux.HandleFunc("/api/notes", s.handleNotes)
	mux.HandleFunc("/api/notes/", s.handleNoteByTitle)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/", s.handleSPA)

	log.Printf("kladde listening on %s, notes=%s, dist=%s", *addr, *notesDir, *distDir)
	if err := http.ListenAndServe(*addr, loggingMiddleware(mux)); err != nil {
		log.Fatal(err)
	}
}

func runAddUser(args []string) error {
	fs := flag.NewFlagSet("adduser", flag.ContinueOnError)
	username := fs.String("username", "", "Username")
	password := fs.String("password", "", "Password")
	name := fs.String("name", "", "Display name")
	usersFile := fs.String("users", "/var/data/kladde/users.json", "Path to users.json")

	if err := fs.Parse(args); err != nil {
		return err
	}

	*username = strings.TrimSpace(*username)
	*password = strings.TrimSpace(*password)
	*name = strings.TrimSpace(*name)

	if *username == "" || *password == "" || *name == "" {
		return errors.New("usage: kladde adduser --username <username> --password <password> --name \"Display Name\"")
	}

	if err := os.MkdirAll(filepath.Dir(*usersFile), 0o755); err != nil {
		return fmt.Errorf("failed creating users dir: %w", err)
	}

	users, err := loadUsers(*usersFile)
	if err != nil {
		return err
	}

	for _, u := range users {
		if u.Username == *username {
			return fmt.Errorf("user %q already exists", *username)
		}
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(*password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed hashing password: %w", err)
	}

	users = append(users, UserRecord{
		Username:     *username,
		PasswordHash: string(hash),
		DisplayName:  *name,
	})

	if err := saveUsers(*usersFile, users); err != nil {
		return err
	}

	log.Printf("user %q added", *username)
	return nil
}

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
		writeError(w, http.StatusBadRequest, errors.New("failed loading users"))
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
		writeError(w, http.StatusBadRequest, errors.New("failed hashing password"))
		return
	}

	users[matchedIndex].PasswordHash = string(hash)
	if err := saveUsers(s.usersFile, users); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("failed saving password"))
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func loadUsers(path string) ([]UserRecord, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []UserRecord{}, nil
		}
		return nil, fmt.Errorf("failed reading users file: %w", err)
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return []UserRecord{}, nil
	}

	var users []UserRecord
	if err := json.Unmarshal(data, &users); err != nil {
		return nil, fmt.Errorf("failed parsing users file: %w", err)
	}
	return users, nil
}

func saveUsers(path string, users []UserRecord) error {
	data, err := json.MarshalIndent(users, "", "  ")
	if err != nil {
		return fmt.Errorf("failed serializing users: %w", err)
	}
	data = append(data, '\n')

	if err := writeFileAtomic(path, data, 0o600); err != nil {
		return fmt.Errorf("failed writing users file: %w", err)
	}
	return nil
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

func (s *Server) userNotesDir(userID string) string {
	return filepath.Join(s.notesBaseDir, userID)
}

func (s *Server) handleNotes(w http.ResponseWriter, r *http.Request) {
	session, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	userDir := s.userNotesDir(session.User.Username)
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	switch r.Method {
	case http.MethodGet:
		notes, err := s.listNotes(userDir)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, notes)
	case http.MethodPost:
		var payload struct {
			Title   string `json:"title"`
			Content string `json:"content"`
		}
		if err := decodeJSONBody(w, r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		title := strings.TrimSpace(payload.Title)
		if err := validateTitle(title); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		note, err := s.saveNote(userDir, title, payload.Content)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusCreated, note)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleNoteByTitle(w http.ResponseWriter, r *http.Request) {
	session, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	userDir := s.userNotesDir(session.User.Username)
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/api/notes/")
	rest = strings.TrimSpace(strings.TrimSuffix(rest, "/"))
	parts := strings.Split(rest, "/")

	if len(parts) == 2 && parts[1] == "rename" {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		oldTitle, err := url.PathUnescape(parts[0])
		if err != nil {
			writeError(w, http.StatusBadRequest, errors.New("invalid note path encoding"))
			return
		}
		oldTitle = strings.TrimSpace(oldTitle)
		if err := validateTitle(oldTitle); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		var payload struct {
			NewTitle string `json:"newTitle"`
		}
		if err := decodeJSONBody(w, r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		note, err := s.renameNote(userDir, oldTitle, strings.TrimSpace(payload.NewTitle))
		if err != nil {
			switch {
			case errors.Is(err, fs.ErrNotExist):
				writeError(w, http.StatusNotFound, errors.New("note not found"))
			default:
				if strings.Contains(err.Error(), "title") {
					writeError(w, http.StatusBadRequest, err)
				} else {
					writeError(w, http.StatusInternalServerError, err)
				}
			}
			return
		}

		writeJSON(w, http.StatusOK, note)
		return
	}

	if len(parts) != 1 {
		writeError(w, http.StatusBadRequest, errors.New("invalid note path"))
		return
	}

	title, err := url.PathUnescape(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid note path encoding"))
		return
	}
	title = strings.TrimSpace(title)
	if err := validateTitle(title); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	switch r.Method {
	case http.MethodGet:
		note, err := s.getNote(userDir, title)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				writeError(w, http.StatusNotFound, errors.New("note not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, note)
	case http.MethodPut:
		var payload struct {
			Content string `json:"content"`
		}
		if err := decodeJSONBody(w, r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		note, err := s.saveNote(userDir, title, payload.Content)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, note)
	case http.MethodDelete:
		if err := s.deleteNote(userDir, title); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				writeError(w, http.StatusNotFound, errors.New("note not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) listNotes(notesDir string) ([]NoteMeta, error) {
	entries, err := os.ReadDir(notesDir)
	if err != nil {
		return nil, err
	}

	result := make([]NoteMeta, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		title := strings.TrimSuffix(entry.Name(), ".md")
		result = append(result, NoteMeta{Title: title, UpdatedAt: info.ModTime()})
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].UpdatedAt.After(result[j].UpdatedAt)
	})

	return result, nil
}

func (s *Server) getNote(notesDir, title string) (*Note, error) {
	path, err := s.notePath(notesDir, title)
	if err != nil {
		return nil, err
	}
	if err := rejectSymlink(path); err != nil {
		return nil, err
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &Note{Title: title, Content: string(content), UpdatedAt: info.ModTime()}, nil
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

func (s *Server) saveNote(notesDir, title, content string) (*Note, error) {
	path, err := s.notePath(notesDir, title)
	if err != nil {
		return nil, err
	}
	if err := writeFileAtomic(path, []byte(content), 0o644); err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &Note{Title: title, Content: content, UpdatedAt: info.ModTime()}, nil
}

func (s *Server) deleteNote(notesDir, title string) error {
	path, err := s.notePath(notesDir, title)
	if err != nil {
		return err
	}
	if err := rejectSymlink(path); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}

	d, err := os.Open(notesDir)
	if err == nil {
		_ = d.Sync()
		_ = d.Close()
	}

	return nil
}

func (s *Server) renameNote(notesDir, oldTitle, newTitle string) (*Note, error) {
	if err := validateTitle(newTitle); err != nil {
		return nil, err
	}

	oldPath, err := s.notePath(notesDir, oldTitle)
	if err != nil {
		return nil, err
	}

	if err := rejectSymlink(oldPath); err != nil {
		return nil, err
	}

	if _, err := os.Stat(oldPath); err != nil {
		return nil, err
	}

	if oldTitle != newTitle {
		baseTitle := newTitle
		for n := 2; ; n++ {
			newPath, err := s.notePath(notesDir, newTitle)
			if err != nil {
				return nil, err
			}

			err = os.Link(oldPath, newPath)
			if err == nil {
				if err := os.Remove(oldPath); err != nil {
					_ = os.Remove(newPath)
					return nil, err
				}
				break
			}

			if errors.Is(err, fs.ErrExist) {
				if info, lerr := os.Lstat(newPath); lerr == nil && info.Mode()&os.ModeSymlink != 0 {
					return nil, errors.New("symlink notes are not allowed")
				}
				newTitle = fmt.Sprintf("%s (%d)", baseTitle, n)
				continue
			}

			return nil, err
		}
	}

	return s.getNote(notesDir, newTitle)
}

func (s *Server) notePath(notesDir, title string) (string, error) {
	if err := validateTitle(title); err != nil {
		return "", err
	}

	base, err := filepath.Abs(notesDir)
	if err != nil {
		return "", err
	}

	path := filepath.Join(base, title+".md")
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

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dest any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodySize)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	if err := dec.Decode(dest); err != nil {
		var synErr *json.SyntaxError
		if errors.As(err, &synErr) {
			return errors.New("invalid JSON body")
		}
		if errors.Is(err, io.EOF) {
			return errors.New("empty JSON body")
		}
		if strings.Contains(err.Error(), "http: request body too large") {
			return fmt.Errorf("request body exceeds %d bytes", maxJSONBodySize)
		}
		return errors.New("invalid JSON body")
	}

	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("invalid JSON body")
	}

	return nil
}

func (s *Server) handleSPA(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}

	requested := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if requested == "." || requested == "" {
		http.ServeFile(w, r, filepath.Join(s.distDir, "index.html"))
		return
	}

	absDist, err := filepath.Abs(s.distDir)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	full := filepath.Join(absDist, requested)
	absFull, err := filepath.Abs(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	prefix := absDist + string(os.PathSeparator)
	if absFull != absDist && !strings.HasPrefix(absFull, prefix) {
		http.NotFound(w, r)
		return
	}

	if info, err := os.Stat(absFull); err == nil && !info.IsDir() {
		if ct := mime.TypeByExtension(filepath.Ext(absFull)); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		http.ServeFile(w, r, absFull)
		return
	}

	http.ServeFile(w, r, filepath.Join(absDist, "index.html"))
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}

func randomToken(numBytes int) (string, error) {
	buf := make([]byte, numBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
