package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
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

func (s *Server) requireEditShareToken(token string) (ShareRecord, error) {
	if err := ensureShareToken(token); err != nil {
		return ShareRecord{}, err
	}
	record, ok := s.findShare(token)
	if !ok || record.Mode != shareModeEdit {
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

func (s *Server) listEditShareTokensForFile(file string) []string {
	s.sharesMu.RLock()
	defer s.sharesMu.RUnlock()

	result := make([]string, 0, 2)
	for token, record := range s.shares {
		if record.Mode != shareModeEdit || record.File != file {
			continue
		}
		result = append(result, token)
	}
	return result
}

func (s *Server) createShare(file, mode string) (string, error) {
	if mode = normalizeShareMode(mode); mode == "" {
		return "", errors.New("invalid share mode")
	}
	if _, _, _, err := parseShareFileRef(file); err != nil {
		return "", errors.New("invalid shared file path")
	}

	s.sharesMu.Lock()
	defer s.sharesMu.Unlock()

	for token, record := range s.shares {
		if record.File == file && record.Mode == mode {
			delete(s.shares, token)
		}
	}

	token, err := randomToken(18)
	if err != nil {
		return "", err
	}
	s.shares[token] = ShareRecord{
		File:    file,
		Mode:    mode,
		Created: time.Now().UTC().Format(time.RFC3339),
	}
	if err := s.persistSharesLocked(); err != nil {
		return "", err
	}
	return token, nil
}

func (s *Server) revokeShare(file, mode string) error {
	mode = normalizeShareMode(mode)
	if mode == "" {
		return errors.New("invalid share mode")
	}

	s.sharesMu.Lock()
	defer s.sharesMu.Unlock()

	for token, record := range s.shares {
		if record.File == file && record.Mode == mode {
			delete(s.shares, token)
		}
	}
	return s.persistSharesLocked()
}

func (s *Server) revokeSharesForFile(file string) error {
	s.sharesMu.Lock()
	defer s.sharesMu.Unlock()

	changed := false
	for token, record := range s.shares {
		if record.File != file {
			continue
		}
		delete(s.shares, token)
		changed = true
	}
	if !changed {
		return nil
	}
	return s.persistSharesLocked()
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
	for _, token := range s.listEditShareTokensForFile(file) {
		s.hub.Broadcast(shareBroadcastChannel(token), event)
	}
}

var readonlyRenderer = goldmark.New(
	goldmark.WithExtensions(extension.GFM),
)

var readonlyShareTemplate = template.Must(template.New("readonly-share").Parse(`<!doctype html>
<html lang="da">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{.Title}} · kladde</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f0ece4;
        --panel: #f7f4ed;
        --text: #292524;
        --muted: #78716c;
        --accent: #57534e;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #292321;
          --panel: #322b28;
          --text: #ece7e2;
          --muted: #a8a29e;
          --accent: #d6d3d1;
        }
      }
      body {
        margin: 0;
        font-family: Inter, system-ui, sans-serif;
        background: var(--bg);
        color: var(--text);
      }
      main {
        width: min(820px, calc(100vw - 2rem));
        margin: 1.5rem auto 3rem;
      }
      .card {
        background: var(--panel);
        border-radius: .8rem;
        padding: 1rem 1.1rem;
      }
      h1 {
        margin: 0;
        font-size: clamp(1.5rem, 3vw, 2rem);
      }
      .top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: .6rem;
        margin-bottom: .85rem;
      }
      .copy {
        border: 0;
        border-radius: 999px;
        background: color-mix(in srgb, var(--accent) 16%, var(--panel));
        color: var(--text);
        padding: .55rem .85rem;
        font-size: .92rem;
        cursor: pointer;
      }
      .status {
        color: var(--muted);
        font-size: .85rem;
      }
      article {
        font-size: 1.05rem;
        line-height: 1.6;
      }
      article :first-child { margin-top: 0; }
      article :last-child { margin-bottom: 0; }
      article code {
        background: color-mix(in srgb, var(--muted) 18%, transparent);
        border-radius: .3rem;
        padding: .1rem .28rem;
      }
      article pre {
        background: color-mix(in srgb, var(--muted) 18%, transparent);
        border-radius: .45rem;
        padding: .7rem;
        overflow-x: auto;
      }
      article pre code {
        background: transparent;
        padding: 0;
      }
      article blockquote {
        margin: .8rem 0;
        padding-left: .8rem;
        border-left: 3px solid color-mix(in srgb, var(--muted) 35%, transparent);
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <div class="top">
          <h1>{{.Title}}</h1>
          <button class="copy" id="copy-md" type="button">Kopiér som markdown</button>
        </div>
        <div class="status" id="copy-status"></div>
        <article>{{.HTML}}</article>
      </div>
    </main>
    <script>
      const markdown = {{.MarkdownJSON}};
      const button = document.getElementById('copy-md');
      const status = document.getElementById('copy-status');
      button?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(markdown);
          if (status) status.textContent = 'Markdown kopieret';
        } catch {
          if (status) status.textContent = 'Kunne ikke kopiere';
        }
      });
    </script>
  </body>
</html>`))

func renderReadonlyMarkdown(markdown string) (template.HTML, error) {
	var out bytes.Buffer
	if err := readonlyRenderer.Convert([]byte(markdown), &out); err != nil {
		return "", err
	}
	return template.HTML(out.String()), nil
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

	record, ok := s.findShare(token)
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("share not found"))
		return
	}

	switch record.Mode {
	case shareModeView:
		s.renderReadonlySharePage(w, record)
	case shareModeEdit:
		http.ServeFile(w, r, filepath.Join(s.clientDir, "index.html"))
	default:
		writeError(w, http.StatusNotFound, errors.New("share not found"))
	}
}

func (s *Server) renderReadonlySharePage(w http.ResponseWriter, record ShareRecord) {
	username, title, collection, err := parseShareFileRef(record.File)
	if err != nil {
		writeError(w, http.StatusNotFound, errors.New("share not found"))
		return
	}

	note, err := s.getNote(s.userNotesDir(username), title, collection)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			writeError(w, http.StatusNotFound, errors.New("note not found"))
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	htmlContent, err := renderReadonlyMarkdown(note.Content)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	markdownJSON, _ := json.Marshal(note.Content)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := readonlyShareTemplate.Execute(w, map[string]any{
		"Title":        note.Title,
		"HTML":         htmlContent,
		"MarkdownJSON": template.JS(string(markdownJSON)),
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err)
	}
}

func (s *Server) handleSharedNoteAPI(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/share/"), "/")
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

	record, err := s.requireEditShareToken(token)
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
		writeJSON(w, http.StatusOK, note)
	case http.MethodPut:
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

		s.recordRecentChangeOrigin(username, collection, title, origin)
		s.broadcastNoteChange(username, NoteChangeEvent{
			Type:       "note_changed",
			Key:        note.Key,
			Title:      note.Title,
			Collection: note.Collection,
			Action:     action,
			Origin:     origin,
		})
		writeJSON(w, http.StatusOK, note)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}
