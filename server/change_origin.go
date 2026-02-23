package main

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

const changeOriginHeader = "X-Kladde-Origin"

type recentOriginEntry struct {
	origin    string
	expiresAt time.Time
}

type RecentChangeOrigins struct {
	mu      sync.Mutex
	entries map[string]recentOriginEntry
	ttl     time.Duration
}

func NewRecentChangeOrigins() *RecentChangeOrigins {
	return &RecentChangeOrigins{
		entries: make(map[string]recentOriginEntry),
		ttl:     3 * time.Second,
	}
}

func (r *RecentChangeOrigins) key(username, title string) string {
	return username + "\x00" + title
}

func (r *RecentChangeOrigins) Record(username, title, origin string) {
	if username == "" || title == "" {
		return
	}
	now := time.Now()
	k := r.key(username, title)

	r.mu.Lock()
	r.entries[k] = recentOriginEntry{origin: origin, expiresAt: now.Add(r.ttl)}
	for existingKey, entry := range r.entries {
		if !entry.expiresAt.After(now) {
			delete(r.entries, existingKey)
		}
	}
	r.mu.Unlock()
}

func (r *RecentChangeOrigins) Consume(username, title string) (string, bool) {
	if username == "" || title == "" {
		return "", false
	}
	now := time.Now()
	k := r.key(username, title)

	r.mu.Lock()
	defer r.mu.Unlock()

	entry, ok := r.entries[k]
	if !ok {
		return "", false
	}
	delete(r.entries, k)
	if !entry.expiresAt.After(now) {
		return "", false
	}
	return entry.origin, true
}

func (s *Server) recordRecentChangeOrigin(username, title, origin string) {
	if s.recentChangeOrigins == nil {
		return
	}
	s.recentChangeOrigins.Record(username, title, origin)
}

func (s *Server) consumeRecentChangeOrigin(username, title string) (string, bool) {
	if s.recentChangeOrigins == nil {
		return "", false
	}
	return s.recentChangeOrigins.Consume(username, title)
}

func readChangeOrigin(r *http.Request) string {
	origin := strings.TrimSpace(r.Header.Get(changeOriginHeader))
	if origin == "" {
		return ""
	}
	if len(origin) > 128 {
		origin = origin[:128]
	}
	return origin
}
