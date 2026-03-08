package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const maxMarkdownBodySize = 8 << 20 // 8MB

type AgentNoteMeta struct {
	Path       string `json:"path"`
	Title      string `json:"title"`
	Collection string `json:"collection,omitempty"`
	UpdatedAt  string `json:"updatedAt"`
}

type AgentSearchMatch struct {
	Line int    `json:"line"`
	Text string `json:"text"`
}

type AgentSearchResult struct {
	Path       string             `json:"path"`
	Title      string             `json:"title"`
	Collection string             `json:"collection,omitempty"`
	Matches    []AgentSearchMatch `json:"matches"`
}

func agentNotePath(title, collection string) string {
	if collection == "" {
		return title
	}
	return collection + "/" + title
}

func parseAgentPathValue(raw string, unescape bool) (string, string, error) {
	raw = strings.TrimSpace(strings.Trim(raw, "/"))
	if raw == "" {
		return "", "", errors.New("invalid note path")
	}

	parts := strings.Split(raw, "/")
	if len(parts) > 2 {
		return "", "", errors.New("invalid note path")
	}

	values := make([]string, 0, len(parts))
	for _, part := range parts {
		value := part
		if unescape {
			decoded, err := url.PathUnescape(part)
			if err != nil {
				return "", "", errors.New("invalid note path encoding")
			}
			value = decoded
		}
		value = strings.TrimSpace(value)
		if value == "" {
			return "", "", errors.New("invalid note path")
		}
		values = append(values, value)
	}

	title := values[len(values)-1]
	collection := ""
	if len(values) == 2 {
		collection = values[0]
	}

	if err := validateTitle(title); err != nil {
		return "", "", err
	}
	if err := validateCollection(collection); err != nil {
		return "", "", err
	}

	return title, collection, nil
}

func parseAgentNotePath(r *http.Request) (string, string, error) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/notes/")
	return parseAgentPathValue(rest, true)
}

func readMarkdownBody(w http.ResponseWriter, r *http.Request) (string, error) {
	reader := http.MaxBytesReader(w, r.Body, maxMarkdownBodySize)
	body, err := io.ReadAll(reader)
	if err != nil {
		if strings.Contains(err.Error(), "http: request body too large") {
			return "", fmt.Errorf("request body exceeds %d bytes", maxMarkdownBodySize)
		}
		return "", err
	}
	return string(body), nil
}

func writeMarkdown(w http.ResponseWriter, status int, content string) {
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(content))
}

func (s *Server) handleAgentAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Path != "/api" {
		s.handleAPINotFound(w, r)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"kladde": "0.1.0",
		"endpoints": map[string]string{
			"GET /api":                  "Self-documenting API info",
			"GET /api/notes":            "List all notes (JSON)",
			"GET /api/notes/{path}":     "Read note (markdown)",
			"PUT /api/notes/{path}":     "Write note (markdown body)",
			"PATCH /api/notes/{path}":   "Find-and-replace (JSON: {find, replace})",
			"DELETE /api/notes/{path}":  "Delete note",
			"PUT /api/move":             "Move/rename note (JSON: {from, to})",
			"GET /api/search?q={query}": "Full-text search across notes (JSON)",
		},
		"auth": "Bearer token in Authorization header",
		"content-type": map[string]string{
			"GET /api/notes/{path}":   "text/markdown",
			"PUT /api/notes/{path}":   "text/markdown",
			"PATCH /api/notes/{path}": "application/json request, text/markdown response",
			"PUT /api/move":           "application/json",
			"GET /api/notes":          "application/json",
			"GET /api/search":         "application/json",
			"errors":                  "application/json",
		},
		"token-format": "kld_<id>.<secret>",
	})
}

func (s *Server) handleAgentNotes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	principal, ok := s.requireAPIKey(w, r)
	if !ok {
		return
	}

	userDir := s.userNotesDir(principal.Username)
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	notes, err := s.listNotes(userDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	result := make([]AgentNoteMeta, 0, len(notes))
	for _, note := range notes {
		result = append(result, AgentNoteMeta{
			Path:       agentNotePath(note.Title, note.Collection),
			Title:      note.Title,
			Collection: note.Collection,
			UpdatedAt:  note.UpdatedAt.UTC().Format(time.RFC3339),
		})
	}

	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleAgentNoteByPath(w http.ResponseWriter, r *http.Request) {
	principal, ok := s.requireAPIKey(w, r)
	if !ok {
		return
	}

	userDir := s.userNotesDir(principal.Username)
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	title, collection, err := parseAgentNotePath(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	switch r.Method {
	case http.MethodGet:
		note, err := s.getNote(userDir, title, collection)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				writeError(w, http.StatusNotFound, errors.New("note not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeMarkdown(w, http.StatusOK, note.Content)
	case http.MethodPut:
		if principal.ReadOnly {
			writeError(w, http.StatusForbidden, errors.New("api key is read-only"))
			return
		}

		content, err := readMarkdownBody(w, r)
		if err != nil {
			if strings.Contains(err.Error(), "request body exceeds") {
				writeError(w, http.StatusRequestEntityTooLarge, err)
				return
			}
			writeError(w, http.StatusBadRequest, err)
			return
		}

		note, action, err := s.saveNote(userDir, title, collection, content)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		status := http.StatusOK
		if action == "created" {
			status = http.StatusCreated
		}
		writeMarkdown(w, status, note.Content)
	case http.MethodPatch:
		if principal.ReadOnly {
			writeError(w, http.StatusForbidden, errors.New("api key is read-only"))
			return
		}

		var payload struct {
			Find    string `json:"find"`
			Replace string `json:"replace"`
		}
		if err := decodeJSONBody(w, r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if payload.Find == "" {
			writeError(w, http.StatusBadRequest, errors.New("find must not be empty"))
			return
		}

		note, err := s.getNote(userDir, title, collection)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				writeError(w, http.StatusNotFound, errors.New("note not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		matchCount := strings.Count(note.Content, payload.Find)
		if matchCount == 0 {
			writeError(w, http.StatusConflict, errors.New("find string not found"))
			return
		}
		if matchCount > 1 {
			writeError(w, http.StatusConflict, fmt.Errorf("find string matched %d locations; expected exactly 1", matchCount))
			return
		}

		updated := strings.Replace(note.Content, payload.Find, payload.Replace, 1)
		if _, _, err := s.saveNote(userDir, title, collection, updated); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeMarkdown(w, http.StatusOK, updated)
	case http.MethodDelete:
		if principal.ReadOnly {
			writeError(w, http.StatusForbidden, errors.New("api key is read-only"))
			return
		}

		if err := s.deleteNote(userDir, title, collection); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				writeError(w, http.StatusNotFound, errors.New("note not found"))
				return
			}
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		if err := s.revokeSharesForFile(shareFileRef(principal.Username, title, collection)); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAgentMove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	principal, ok := s.requireAPIKey(w, r)
	if !ok {
		return
	}
	if principal.ReadOnly {
		writeError(w, http.StatusForbidden, errors.New("api key is read-only"))
		return
	}

	var payload struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := decodeJSONBody(w, r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	oldTitle, oldCollection, err := parseAgentPathValue(payload.From, false)
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid from path: %w", err))
		return
	}
	newTitle, newCollection, err := parseAgentPathValue(payload.To, false)
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("invalid to path: %w", err))
		return
	}

	userDir := s.userNotesDir(principal.Username)
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	note, err := s.renameNote(userDir, oldTitle, oldCollection, newTitle, newCollection)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			writeError(w, http.StatusNotFound, errors.New("note not found"))
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	oldFile := shareFileRef(principal.Username, oldTitle, oldCollection)
	newFile := shareFileRef(principal.Username, note.Title, note.Collection)
	if err := s.retargetSharesForFile(oldFile, newFile); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"from": payload.From,
		"to":   agentNotePath(note.Title, note.Collection),
	})
}

func (s *Server) handleAgentSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	principal, ok := s.requireAPIKey(w, r)
	if !ok {
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeError(w, http.StatusBadRequest, errors.New("q is required"))
		return
	}
	needle := strings.ToLower(query)

	userDir := s.userNotesDir(principal.Username)
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	notes, err := s.listNotes(userDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	results := make([]AgentSearchResult, 0)
	for _, meta := range notes {
		note, err := s.getNote(userDir, meta.Title, meta.Collection)
		if err != nil {
			continue
		}

		matches := make([]AgentSearchMatch, 0)
		scanner := bufio.NewScanner(strings.NewReader(note.Content))
		lineNo := 0
		for scanner.Scan() {
			lineNo++
			line := scanner.Text()
			if strings.Contains(strings.ToLower(line), needle) {
				matches = append(matches, AgentSearchMatch{Line: lineNo, Text: line})
			}
		}
		if len(matches) == 0 {
			continue
		}

		results = append(results, AgentSearchResult{
			Path:       agentNotePath(meta.Title, meta.Collection),
			Title:      meta.Title,
			Collection: meta.Collection,
			Matches:    matches,
		})
	}

	writeJSON(w, http.StatusOK, results)
}
