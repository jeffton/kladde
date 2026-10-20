package main

import (
	"encoding/json"
	"errors"
	"os"
	"time"
)

func (s *Server) loadSessions() error {
	data, err := os.ReadFile(s.sessionsFile)
	if errors.Is(err, os.ErrNotExist) {
		s.sessions = make(map[string]Session)
		return nil
	}
	if err != nil {
		return err
	}
	var sessions map[string]Session
	if err := json.Unmarshal(data, &sessions); err != nil {
		return err
	}
	s.sessions = make(map[string]Session)
	now := time.Now()
	for id, session := range sessions {
		if now.Before(session.ExpiresAt) {
			s.sessions[id] = session
		}
	}
	return nil
}

// storeSession commits disk and memory together. A zero session removes the ID.
func (s *Server) storeSession(id string, session Session) error {
	s.sessionsMu.Lock()
	defer s.sessionsMu.Unlock()

	sessions := make(map[string]Session, len(s.sessions)+1)
	now := time.Now()
	for key, value := range s.sessions {
		if key != id && now.Before(value.ExpiresAt) {
			sessions[key] = value
		}
	}
	if !session.ExpiresAt.IsZero() {
		sessions[id] = session
	}
	data, err := json.Marshal(sessions)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(s.sessionsFile, data, 0o600); err != nil {
		return err
	}
	s.sessions = sessions
	return nil
}
