package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

const (
	shareModeView = "view"
	shareModeEdit = "edit"
)

func userBroadcastChannel(username string) string {
	return "user:" + username
}

func shareBroadcastChannel(token string) string {
	return "share:" + token
}

func normalizeShareMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case shareModeView:
		return shareModeView
	case shareModeEdit:
		return shareModeEdit
	default:
		return ""
	}
}

func ensureShareToken(token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return errors.New("share token is required")
	}
	if len(token) > 200 {
		return errors.New("share token is invalid")
	}
	for _, r := range token {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return errors.New("share token is invalid")
	}
	return nil
}

func shareFileRef(username, title, collection string) string {
	filename := title + ".md"
	if collection == "" {
		return path.Join(username, filename)
	}
	return path.Join(username, collection, filename)
}

func parseShareFileRef(file string) (username, title, collection string, err error) {
	clean := path.Clean(strings.TrimSpace(strings.ReplaceAll(file, "\\", "/")))
	if clean == "" || clean == "." || strings.HasPrefix(clean, "../") {
		return "", "", "", errors.New("invalid shared file path")
	}

	parts := strings.Split(clean, "/")
	if len(parts) != 2 && len(parts) != 3 {
		return "", "", "", errors.New("invalid shared file path")
	}

	username = strings.TrimSpace(parts[0])
	if username == "" || strings.Contains(username, "..") || strings.Contains(username, "/") {
		return "", "", "", errors.New("invalid shared file path")
	}

	filename := parts[len(parts)-1]
	if strings.HasPrefix(filename, ".") || filepath.Ext(filename) != ".md" {
		return "", "", "", errors.New("invalid shared file path")
	}

	title = strings.TrimSuffix(filename, ".md")
	if err := validateTitle(title); err != nil {
		return "", "", "", err
	}

	if len(parts) == 3 {
		collection = normalizeCollection(parts[1])
		if err := validateCollection(collection); err != nil {
			return "", "", "", err
		}
	}

	return username, title, collection, nil
}

func (s *Server) loadShares() error {
	s.sharesMu.Lock()
	defer s.sharesMu.Unlock()

	data, err := os.ReadFile(s.sharesFile)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			s.shares = map[string]ShareRecord{}
			return s.persistSharesLocked()
		}
		return fmt.Errorf("failed reading shares file: %w", err)
	}

	if len(strings.TrimSpace(string(data))) == 0 {
		s.shares = map[string]ShareRecord{}
		return nil
	}

	parsed := map[string]ShareRecord{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return fmt.Errorf("failed parsing shares file: %w", err)
	}

	normalized := make(map[string]ShareRecord, len(parsed))
	for token, record := range parsed {
		token = strings.TrimSpace(token)
		if err := ensureShareToken(token); err != nil {
			continue
		}
		mode := normalizeShareMode(record.Mode)
		if mode == "" {
			continue
		}
		file := path.Clean(strings.TrimSpace(strings.ReplaceAll(record.File, "\\", "/")))
		if _, _, _, err := parseShareFileRef(file); err != nil {
			continue
		}
		created := strings.TrimSpace(record.Created)
		if created == "" {
			created = time.Now().UTC().Format(time.RFC3339)
		}
		normalized[token] = ShareRecord{File: file, Mode: mode, Created: created}
	}

	s.shares = normalized
	return nil
}

func (s *Server) persistSharesLocked() error {
	if s.shares == nil {
		s.shares = map[string]ShareRecord{}
	}
	data, err := json.MarshalIndent(s.shares, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writeFileAtomic(s.sharesFile, data, 0o600)
}

func (s *Server) findShare(token string) (ShareRecord, bool) {
	s.sharesMu.RLock()
	record, ok := s.shares[token]
	s.sharesMu.RUnlock()
	return record, ok
}

func (s *Server) requireShareToken(token string) (ShareRecord, error) {
	if err := ensureShareToken(token); err != nil {
		return ShareRecord{}, err
	}
	record, ok := s.findShare(token)
	if !ok {
		return ShareRecord{}, errors.New("invalid share token")
	}
	if _, _, _, err := parseShareFileRef(record.File); err != nil {
		return ShareRecord{}, errors.New("invalid share token")
	}
	return record, nil
}

func (s *Server) tokenForFileAndMode(file, mode string) string {
	s.sharesMu.RLock()
	defer s.sharesMu.RUnlock()

	for token, record := range s.shares {
		if record.File == file && record.Mode == mode {
			return token
		}
	}
	return ""
}

func (s *Server) listShareTokensForFile(file string) []string {
	s.sharesMu.RLock()
	defer s.sharesMu.RUnlock()

	result := make([]string, 0, 2)
	for token, record := range s.shares {
		if record.File != file {
			continue
		}
		result = append(result, token)
	}
	return result
}

func (s *Server) closeShareChannels(tokens []string) {
	if s.hub == nil {
		return
	}
	for _, token := range tokens {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		s.hub.CloseChannel(shareBroadcastChannel(token))
	}
}

func (s *Server) createShare(file, mode string) (string, error) {
	if mode = normalizeShareMode(mode); mode == "" {
		return "", errors.New("invalid share mode")
	}
	if _, _, _, err := parseShareFileRef(file); err != nil {
		return "", errors.New("invalid shared file path")
	}

	replacedTokens := make([]string, 0, 1)

	s.sharesMu.Lock()
	for token, record := range s.shares {
		if record.File == file && record.Mode == mode {
			delete(s.shares, token)
			replacedTokens = append(replacedTokens, token)
		}
	}

	token, err := randomToken(18)
	if err != nil {
		s.sharesMu.Unlock()
		return "", err
	}
	s.shares[token] = ShareRecord{
		File:    file,
		Mode:    mode,
		Created: time.Now().UTC().Format(time.RFC3339),
	}
	if err := s.persistSharesLocked(); err != nil {
		s.sharesMu.Unlock()
		return "", err
	}
	s.sharesMu.Unlock()

	s.closeShareChannels(replacedTokens)
	return token, nil
}

func (s *Server) revokeShare(file, mode string) error {
	mode = normalizeShareMode(mode)
	if mode == "" {
		return errors.New("invalid share mode")
	}

	revokedTokens := make([]string, 0, 1)

	s.sharesMu.Lock()
	for token, record := range s.shares {
		if record.File == file && record.Mode == mode {
			delete(s.shares, token)
			revokedTokens = append(revokedTokens, token)
		}
	}
	if len(revokedTokens) == 0 {
		s.sharesMu.Unlock()
		return nil
	}
	if err := s.persistSharesLocked(); err != nil {
		s.sharesMu.Unlock()
		return err
	}
	s.sharesMu.Unlock()

	s.closeShareChannels(revokedTokens)
	return nil
}

func (s *Server) revokeSharesForFile(file string) error {
	revokedTokens := make([]string, 0, 2)

	s.sharesMu.Lock()
	for token, record := range s.shares {
		if record.File != file {
			continue
		}
		delete(s.shares, token)
		revokedTokens = append(revokedTokens, token)
	}
	if len(revokedTokens) == 0 {
		s.sharesMu.Unlock()
		return nil
	}
	if err := s.persistSharesLocked(); err != nil {
		s.sharesMu.Unlock()
		return err
	}
	s.sharesMu.Unlock()

	s.closeShareChannels(revokedTokens)
	return nil
}

func (s *Server) retargetSharesForFile(oldFile, newFile string) error {
	if oldFile == newFile {
		return nil
	}

	s.sharesMu.Lock()
	defer s.sharesMu.Unlock()

	changed := false
	for token, record := range s.shares {
		if record.File != oldFile {
			continue
		}
		record.File = newFile
		s.shares[token] = record
		changed = true
	}
	if !changed {
		return nil
	}
	return s.persistSharesLocked()
}

func requestScheme(r *http.Request) string {
	if proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); proto != "" {
		return proto
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

func buildShareURL(r *http.Request, token string) string {
	return requestScheme(r) + "://" + r.Host + "/share/" + url.PathEscape(token)
}

func (s *Server) shareLinksForFile(r *http.Request, file string) ShareLinksResponse {
	links := ShareLinksResponse{}

	if viewToken := s.tokenForFileAndMode(file, shareModeView); viewToken != "" {
		links.View = ShareLink{Enabled: true, Token: viewToken, URL: buildShareURL(r, viewToken)}
	}
	if editToken := s.tokenForFileAndMode(file, shareModeEdit); editToken != "" {
		links.Edit = ShareLink{Enabled: true, Token: editToken, URL: buildShareURL(r, editToken)}
	}
	return links
}

func (s *Server) handleNoteShare(w http.ResponseWriter, r *http.Request, username, title, collection string) {
	file := shareFileRef(username, title, collection)

	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.shareLinksForFile(r, file))
	case http.MethodPost:
		var payload struct {
			Mode string `json:"mode"`
		}
		if err := decodeJSONBody(w, r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		if _, err := s.createShare(file, payload.Mode); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		writeJSON(w, http.StatusOK, s.shareLinksForFile(r, file))
	case http.MethodDelete:
		mode := normalizeShareMode(r.URL.Query().Get("mode"))
		if mode == "" {
			writeError(w, http.StatusBadRequest, errors.New("mode is required"))
			return
		}
		if err := s.revokeShare(file, mode); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, s.shareLinksForFile(r, file))
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) broadcastNoteChange(username string, event NoteChangeEvent) {
	s.hub.Broadcast(userBroadcastChannel(username), event)

	file := shareFileRef(username, event.Title, event.Collection)
	for _, token := range s.listShareTokensForFile(file) {
		s.hub.Broadcast(shareBroadcastChannel(token), event)
	}
}

func (s *Server) resolveShareTokenFromPath(pathValue, prefix string) (string, error) {
	tokenRaw := strings.TrimSpace(strings.TrimPrefix(pathValue, prefix))
	tokenRaw = strings.Trim(tokenRaw, "/")
	if tokenRaw == "" || strings.Contains(tokenRaw, "/") {
		return "", errors.New("invalid share token")
	}
	token, err := url.PathUnescape(tokenRaw)
	if err != nil {
		return "", errors.New("invalid share token")
	}
	if err := ensureShareToken(token); err != nil {
		return "", err
	}
	return token, nil
}

func (s *Server) handleSharePage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	token, err := s.resolveShareTokenFromPath(r.URL.Path, "/share/")
	if err != nil {
		writeError(w, http.StatusNotFound, errors.New("share not found"))
		return
	}

	record, err := s.requireShareToken(token)
	if err != nil {
		writeError(w, http.StatusNotFound, errors.New("share not found"))
		return
	}
	if record.Mode != shareModeView && record.Mode != shareModeEdit {
		writeError(w, http.StatusNotFound, errors.New("share not found"))
		return
	}

	http.ServeFile(w, r, filepath.Join(s.clientDir, "index.html"))
}

func (s *Server) handleSharedNoteAPI(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/client-api/share/"), "/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[1] != "note" {
		writeError(w, http.StatusNotFound, errors.New("invalid share endpoint"))
		return
	}

	token, err := url.PathUnescape(parts[0])
	if err != nil || ensureShareToken(token) != nil {
		writeError(w, http.StatusUnauthorized, errors.New("invalid share token"))
		return
	}

	record, err := s.requireShareToken(token)
	if err != nil {
		writeError(w, http.StatusUnauthorized, errors.New("invalid share token"))
		return
	}

	username, title, collection, err := parseShareFileRef(record.File)
	if err != nil {
		writeError(w, http.StatusUnauthorized, errors.New("invalid share token"))
		return
	}

	userDir := s.userNotesDir(username)
	origin := readChangeOrigin(r)

	writeSharedNote := func(status int, note *Note, mode string) {
		writeJSON(w, status, map[string]any{
			"key":        note.Key,
			"title":      note.Title,
			"collection": note.Collection,
			"content":    note.Content,
			"updatedAt":  note.UpdatedAt,
			"starred":    note.Starred,
			"shareMode":  mode,
		})
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
		writeSharedNote(http.StatusOK, note, record.Mode)
	case http.MethodPut:
		if record.Mode != shareModeEdit {
			writeError(w, http.StatusForbidden, errors.New("share token is read-only"))
			return
		}

		var payload struct {
			Content string `json:"content"`
		}
		if err := decodeJSONBody(w, r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		note, action, err := s.saveNote(userDir, title, collection, payload.Content)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		s.broadcastNoteChange(username, NoteChangeEvent{
			Type:       "note_changed",
			Key:        note.Key,
			Title:      note.Title,
			Collection: note.Collection,
			Action:     action,
			Origin:     origin,
		})
		writeSharedNote(http.StatusOK, note, record.Mode)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}
