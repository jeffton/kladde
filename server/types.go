package main

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const maxJSONBodySize = 1 << 20 // 1MB
const maxTitleLength = 200
const maxCollectionLength = 120

const sessionCookieName = "kladde_session"

type NoteMeta struct {
	Key        string    `json:"key"`
	Title      string    `json:"title"`
	Collection string    `json:"collection,omitempty"`
	UpdatedAt  time.Time `json:"updatedAt"`
	Starred    bool      `json:"starred"`
}

type Note struct {
	Key        string    `json:"key"`
	Title      string    `json:"title"`
	Collection string    `json:"collection,omitempty"`
	Content    string    `json:"content"`
	UpdatedAt  time.Time `json:"updatedAt"`
	Starred    bool      `json:"starred"`
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

type NoteChangeEvent struct {
	Type       string `json:"type"`
	Key        string `json:"key"`
	Title      string `json:"title"`
	Collection string `json:"collection,omitempty"`
	Action     string `json:"action"`
	Origin     string `json:"origin,omitempty"`
}

type Hub struct {
	mu         sync.RWMutex
	clients    map[string]map[*websocket.Conn]struct{}
	writeLocks map[*websocket.Conn]*sync.Mutex
}

type FileEventDebouncer struct {
	mu      sync.Mutex
	entries map[string]*debouncedEntry
}

type debouncedEntry struct {
	timer *time.Timer
	gen   uint64
}

type Server struct {
	notesBaseDir        string
	clientDir           string
	usersFile           string
	sessions            map[string]Session
	sessionsMu          sync.RWMutex
	usersMu             sync.Mutex
	hub                 *Hub
	recentChangeOrigins *RecentChangeOrigins
	gitBackup           *GitBackup
}
