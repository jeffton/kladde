package main

import (
	"errors"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"strings"
)

func parseCollectionQuery(r *http.Request) (string, error) {
	collection := normalizeCollection(r.URL.Query().Get("collection"))
	if err := validateCollection(collection); err != nil {
		return "", err
	}
	return collection, nil
}

func (s *Server) handleNotes(w http.ResponseWriter, r *http.Request) {
	session, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	userDir := s.userNotesDir(session.User.Username)
	origin := readChangeOrigin(r)
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
			Title      string `json:"title"`
			Content    string `json:"content"`
			Collection string `json:"collection"`
		}
		if err := decodeJSONBody(w, r, &payload); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		title := strings.TrimSpace(strings.ReplaceAll(payload.Title, "/", ""))
		collection := normalizeCollection(payload.Collection)
		if err := validateTitle(title); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if err := validateCollection(collection); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}

		note, err := s.createNote(userDir, title, collection, payload.Content)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		s.broadcastNoteChange(session.User.Username, NoteChangeEvent{
			Type:       "note_changed",
			Key:        note.Key,
			Title:      note.Title,
			Collection: note.Collection,
			Action:     "created",
			Origin:     origin,
		})
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

	collection, err := parseCollectionQuery(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	rest := strings.TrimPrefix(r.URL.EscapedPath(), "/client-api/notes/")
	rest = strings.TrimSpace(strings.TrimSuffix(rest, "/"))
	parts := strings.Split(rest, "/")

	if len(parts) > 2 || (len(parts) == 2 && !isNoteAction(parts[1])) {
		writeError(w, http.StatusBadRequest, errors.New("invalid note path"))
		return
	}

	action := ""
	if len(parts) == 2 {
		action = parts[1]
	}
	if (action == "rename" || action == "star") && r.Method != http.MethodPut {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	title, err := parseNoteRouteTitle(parts[0])
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	note := noteRoute{
		username:   session.User.Username,
		dir:        userDir,
		title:      title,
		collection: collection,
		origin:     readChangeOrigin(r),
	}
	switch action {
	case "rename":
		s.renameNoteResponse(w, r, note)
	case "share":
		s.handleNoteShare(w, r, note.username, note.title, note.collection)
	case "star":
		s.starNoteResponse(w, r, note)
	default:
		s.handleNoteContent(w, r, note)
	}
}

type noteRoute struct {
	username   string
	dir        string
	title      string
	collection string
	origin     string
}

func isNoteAction(action string) bool {
	return action == "rename" || action == "share" || action == "star"
}

func parseNoteRouteTitle(segment string) (string, error) {
	title, err := url.PathUnescape(segment)
	if err != nil {
		return "", errors.New("invalid note path encoding")
	}
	title = strings.TrimSpace(title)
	return title, validateTitle(title)
}

func (s *Server) handleNoteContent(w http.ResponseWriter, r *http.Request, route noteRoute) {
	switch r.Method {
	case http.MethodGet:
		s.readNoteResponse(w, route)
	case http.MethodPut:
		s.saveNoteResponse(w, r, route)
	case http.MethodDelete:
		s.deleteNoteResponse(w, route)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) readNoteResponse(w http.ResponseWriter, route noteRoute) {
	note, err := s.getNote(route.dir, route.title, route.collection)
	if err != nil {
		writeNoteLookupError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, note)
}

func (s *Server) saveNoteResponse(w http.ResponseWriter, r *http.Request, route noteRoute) {
	var payload struct {
		Content string `json:"content"`
	}
	if err := decodeJSONBody(w, r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	note, action, err := s.saveNote(route.dir, route.title, route.collection, payload.Content)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	s.broadcastNoteChange(route.username, NoteChangeEvent{
		Type:       "note_changed",
		Key:        note.Key,
		Title:      note.Title,
		Collection: note.Collection,
		Action:     action,
		Origin:     route.origin,
	})
	writeJSON(w, http.StatusOK, note)
}

func (s *Server) deleteNoteResponse(w http.ResponseWriter, route noteRoute) {
	if err := s.deleteNote(route.dir, route.title, route.collection); err != nil {
		writeNoteLookupError(w, err)
		return
	}

	if err := s.revokeSharesForFile(shareFileRef(route.username, route.title, route.collection)); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	key := noteStorageKey(route.title, route.collection)
	s.broadcastNoteChange(route.username, NoteChangeEvent{
		Type:       "note_changed",
		Key:        key,
		Title:      route.title,
		Collection: route.collection,
		Action:     "deleted",
		Origin:     route.origin,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) renameNoteResponse(w http.ResponseWriter, r *http.Request, route noteRoute) {
	var payload struct {
		NewTitle      string  `json:"newTitle"`
		NewCollection *string `json:"newCollection"`
	}
	if err := decodeJSONBody(w, r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	newCollection := route.collection
	if payload.NewCollection != nil {
		newCollection = normalizeCollection(*payload.NewCollection)
	}
	if err := validateCollection(newCollection); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	newTitle := strings.TrimSpace(strings.ReplaceAll(payload.NewTitle, "/", ""))
	if err := validateTitle(newTitle); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	note, err := s.renameNote(route.dir, route.title, route.collection, newTitle, newCollection)
	if err != nil {
		writeNoteLookupError(w, err)
		return
	}

	oldKey := noteStorageKey(route.title, route.collection)
	oldFile := shareFileRef(route.username, route.title, route.collection)
	newFile := shareFileRef(route.username, note.Title, note.Collection)
	if err := s.retargetSharesForFile(oldFile, newFile); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	s.broadcastNoteChange(route.username, NoteChangeEvent{
		Type:       "note_changed",
		Key:        oldKey,
		Title:      route.title,
		Collection: route.collection,
		Action:     "deleted",
		Origin:     route.origin,
	})
	s.broadcastNoteChange(route.username, NoteChangeEvent{
		Type:       "note_changed",
		Key:        note.Key,
		Title:      note.Title,
		Collection: note.Collection,
		Action:     "created",
		Origin:     route.origin,
	})
	writeJSON(w, http.StatusOK, note)
}

func (s *Server) starNoteResponse(w http.ResponseWriter, r *http.Request, route noteRoute) {
	var payload struct {
		Starred bool `json:"starred"`
	}
	if err := decodeJSONBody(w, r, &payload); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	if payload.Starred {
		path, err := s.notePath(route.dir, route.title, route.collection)
		if err == nil {
			err = rejectSymlink(path)
		}
		if err == nil {
			var info fs.FileInfo
			info, err = os.Stat(path)
			if err == nil && !info.Mode().IsRegular() {
				err = fs.ErrNotExist
			}
		}
		if err != nil {
			writeNoteLookupError(w, err)
			return
		}
	}

	key := noteStorageKey(route.title, route.collection)
	if err := s.setNoteStarred(route.dir, key, payload.Starred); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	s.broadcastNoteChange(route.username, NoteChangeEvent{
		Type:       "note_changed",
		Key:        key,
		Title:      route.title,
		Collection: route.collection,
		Action:     "updated",
		Origin:     route.origin,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"key":        key,
		"title":      route.title,
		"collection": route.collection,
		"starred":    payload.Starred,
	})
}

func writeNoteLookupError(w http.ResponseWriter, err error) {
	if errors.Is(err, fs.ErrNotExist) {
		writeError(w, http.StatusNotFound, errors.New("note not found"))
		return
	}
	writeError(w, http.StatusInternalServerError, err)
}
