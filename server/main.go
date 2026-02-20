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

	optionsFile := flag.String("options", "", "Path to JSON options file")
	flag.Parse()

	if flag.NArg() > 0 {
		log.Fatal("unexpected positional arguments; use only -options <file>")
	}

	opts, err := loadOptions(*optionsFile)
	if err != nil {
		log.Fatal(err)
	}

	if err := os.MkdirAll(opts.Notes, 0o755); err != nil {
		log.Fatalf("failed creating notes dir: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(opts.Users), 0o755); err != nil {
		log.Fatalf("failed creating users dir: %v", err)
	}

	s := &Server{
		notesBaseDir: opts.Notes,
		clientDir:    opts.Client,
		usersFile:    opts.Users,
		sessions:     make(map[string]Session),
		hub:          NewHub(),
	}

	if opts.GitBackup.Enabled {
		backup, err := NewGitBackup(opts.Notes, opts.GitBackup)
		if err != nil {
			log.Fatalf("failed to initialize git backup: %v", err)
		}
		s.gitBackup = backup
		s.triggerGitBackup("startup")
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

	log.Printf("kladde listening on %s, notes=%s, client=%s, gitBackup=%t", opts.Addr, opts.Notes, opts.Client, opts.GitBackup.Enabled)
	if err := http.ListenAndServe(opts.Addr, loggingMiddleware(mux)); err != nil {
		log.Fatal(err)
	}
}
