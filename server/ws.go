package main

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

func NewHub() *Hub {
	return &Hub{
		clients:    make(map[string]map[*websocket.Conn]struct{}),
		writeLocks: make(map[*websocket.Conn]*sync.Mutex),
	}
}

func (h *Hub) Add(username string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients[username] == nil {
		h.clients[username] = make(map[*websocket.Conn]struct{})
	}
	h.clients[username][conn] = struct{}{}
	h.writeLocks[conn] = &sync.Mutex{}
}

func (h *Hub) Remove(username string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.clients[username] == nil {
		return
	}
	delete(h.clients[username], conn)
	delete(h.writeLocks, conn)
	if len(h.clients[username]) == 0 {
		delete(h.clients, username)
	}
}

func (h *Hub) connWriteLock(conn *websocket.Conn) *sync.Mutex {
	h.mu.RLock()
	lock := h.writeLocks[conn]
	h.mu.RUnlock()
	return lock
}

func (h *Hub) Broadcast(username string, event NoteChangeEvent) {
	h.mu.RLock()
	conns := make([]*websocket.Conn, 0, len(h.clients[username]))
	for conn := range h.clients[username] {
		conns = append(conns, conn)
	}
	h.mu.RUnlock()

	for _, conn := range conns {
		lock := h.connWriteLock(conn)
		if lock == nil {
			continue
		}
		lock.Lock()
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		err := conn.WriteJSON(event)
		lock.Unlock()
		if err != nil {
			h.Remove(username, conn)
			_ = conn.Close()
		}
	}
}

func NewFileEventDebouncer() *FileEventDebouncer {
	return &FileEventDebouncer{entries: make(map[string]*debouncedEntry)}
}

func (d *FileEventDebouncer) Trigger(key string, delay time.Duration, fn func()) {
	d.mu.Lock()
	defer d.mu.Unlock()

	entry, ok := d.entries[key]
	if ok {
		entry.timer.Stop()
		entry.gen++
	} else {
		entry = &debouncedEntry{}
		d.entries[key] = entry
	}

	capturedGen := entry.gen
	entry.timer = time.AfterFunc(delay, func() {
		d.mu.Lock()
		current, exists := d.entries[key]
		shouldRun := exists && current.gen == capturedGen
		if shouldRun {
			delete(d.entries, key)
		}
		d.mu.Unlock()

		if shouldRun {
			fn()
		}
	})
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	channel := ""
	if shareToken := strings.TrimSpace(r.URL.Query().Get("shareToken")); shareToken != "" {
		token, err := url.PathUnescape(shareToken)
		if err != nil {
			writeError(w, http.StatusUnauthorized, errors.New("invalid share token"))
			return
		}
		if _, err := s.requireShareToken(token); err != nil {
			writeError(w, http.StatusUnauthorized, errors.New("invalid share token"))
			return
		}
		channel = shareBroadcastChannel(token)
	} else {
		session, ok := s.requireAuth(w, r)
		if !ok {
			return
		}
		channel = userBroadcastChannel(session.User.Username)
	}

	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return false
			}
			u, err := url.Parse(origin)
			if err != nil {
				return false
			}
			return strings.EqualFold(u.Host, r.Host)
		},
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	s.hub.Add(channel, conn)

	conn.SetReadLimit(1024)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	pingTicker := time.NewTicker(30 * time.Second)
	done := make(chan struct{})
	defer func() {
		close(done)
		pingTicker.Stop()
		s.hub.Remove(channel, conn)
		_ = conn.Close()
	}()

	go func() {
		for {
			select {
			case <-pingTicker.C:
				lock := s.hub.connWriteLock(conn)
				if lock == nil {
					return
				}
				lock.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				err := conn.WriteMessage(websocket.PingMessage, nil)
				lock.Unlock()
				if err != nil {
					_ = conn.Close()
					return
				}
			case <-done:
				return
			}
		}
	}()

	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
