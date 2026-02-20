package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

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
		hub:          NewHub(),
	}

	if err := s.startFileWatcher(); err != nil {
		log.Fatalf("failed to start file watcher: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/auth/login", s.handleAuthLogin)
	mux.HandleFunc("/auth/logout", s.handleLogout)
	mux.HandleFunc("/api/me", s.handleMe)
	mux.HandleFunc("/api/me/password", s.handleChangePassword)
	mux.HandleFunc("/api/notes", s.handleNotes)
	mux.HandleFunc("/api/notes/", s.handleNoteByTitle)
	mux.HandleFunc("/api/ws", s.handleWebSocket)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/", s.handleSPA)

	log.Printf("kladde listening on %s, notes=%s, dist=%s", *addr, *notesDir, *distDir)
	if err := http.ListenAndServe(*addr, loggingMiddleware(mux)); err != nil {
		log.Fatal(err)
	}
}
