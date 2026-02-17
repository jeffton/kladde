package main

import (
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
	"time"
	"unicode"
)

const maxJSONBodySize = 1 << 20 // 1MB
const maxTitleLength = 200

type NoteMeta struct {
	Title     string    `json:"title"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Note struct {
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Server struct {
	notesDir string
	distDir  string
}

func main() {
	addr := flag.String("addr", ":8080", "HTTP listen address")
	notesDir := flag.String("notes", "/var/data/noteapp/notes/", "Path to notes directory")
	distDir := flag.String("dist", "../client/dist", "Path to built client dist directory")
	flag.Parse()

	if err := os.MkdirAll(*notesDir, 0o755); err != nil {
		log.Fatalf("failed creating notes dir: %v", err)
	}

	s := &Server{notesDir: *notesDir, distDir: *distDir}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/notes", s.handleNotes)
	mux.HandleFunc("/api/notes/", s.handleNoteByTitle)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/", s.handleSPA)

	log.Printf("noteapp listening on %s, notes=%s, dist=%s", *addr, *notesDir, *distDir)
	if err := http.ListenAndServe(*addr, loggingMiddleware(mux)); err != nil {
		log.Fatal(err)
	}
}

func (s *Server) handleNotes(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		notes, err := s.listNotes()
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
		note, err := s.saveNote(title, payload.Content)
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
	rest := strings.TrimPrefix(r.URL.Path, "/api/notes/")
	rest = strings.TrimSpace(strings.TrimSuffix(rest, "/"))
	parts := strings.Split(rest, "/")

	if len(parts) == 2 && parts[1] == "rename" {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		oldTitle, _ := url.PathUnescape(parts[0])
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

		note, err := s.renameNote(oldTitle, strings.TrimSpace(payload.NewTitle))
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

	title, _ := url.PathUnescape(parts[0])
	title = strings.TrimSpace(title)
	if err := validateTitle(title); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	switch r.Method {
	case http.MethodGet:
		note, err := s.getNote(title)
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
		note, err := s.saveNote(title, payload.Content)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, note)
	case http.MethodDelete:
		if err := s.deleteNote(title); err != nil {
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

func (s *Server) listNotes() ([]NoteMeta, error) {
	entries, err := os.ReadDir(s.notesDir)
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

func (s *Server) getNote(title string) (*Note, error) {
	path := filepath.Join(s.notesDir, title+".md")
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
	tmpFile, err := os.CreateTemp(dir, ".noteapp-*.tmp")
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

func (s *Server) saveNote(title, content string) (*Note, error) {
	path := filepath.Join(s.notesDir, title+".md")
	if err := writeFileAtomic(path, []byte(content), 0o644); err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &Note{Title: title, Content: content, UpdatedAt: info.ModTime()}, nil
}

func (s *Server) deleteNote(title string) error {
	path := filepath.Join(s.notesDir, title+".md")
	if err := os.Remove(path); err != nil {
		return err
	}

	d, err := os.Open(s.notesDir)
	if err == nil {
		_ = d.Sync()
		_ = d.Close()
	}

	return nil
}

func (s *Server) renameNote(oldTitle, newTitle string) (*Note, error) {
	if err := validateTitle(newTitle); err != nil {
		return nil, err
	}

	oldPath := filepath.Join(s.notesDir, oldTitle+".md")
	newPath := filepath.Join(s.notesDir, newTitle+".md")

	if _, err := os.Stat(oldPath); err != nil {
		return nil, err
	}

	if oldTitle != newTitle {
		// Auto-deduplicate: append (n) if title exists
		baseTitle := newTitle
		for n := 2; ; n++ {
			if _, err := os.Stat(newPath); errors.Is(err, fs.ErrNotExist) {
				break
			} else if err != nil {
				return nil, err
			}
			newTitle = fmt.Sprintf("%s (%d)", baseTitle, n)
			newPath = filepath.Join(s.notesDir, newTitle+".md")
		}

		if err := os.Rename(oldPath, newPath); err != nil {
			return nil, err
		}
	}

	return s.getNote(newTitle)
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
