package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "adduser":
			if err := runAddUser(os.Args[2:]); err != nil {
				log.Fatal(err)
			}
			return
		case "addapikey":
			if err := runAddAPIKey(os.Args[2:]); err != nil {
				log.Fatal(err)
			}
			return
		}
	}

	optionsDir := flag.String("options", "", "Path to options directory")
	flag.Parse()

	if flag.NArg() > 0 {
		log.Fatal("unexpected positional arguments; use only -options <directory>")
	}

	opts, err := loadOptions(*optionsDir)
	if err != nil {
		log.Fatal(err)
	}

	if err := os.MkdirAll(opts.Notes, 0o755); err != nil {
		log.Fatalf("failed creating notes dir: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(opts.UsersFile), 0o755); err != nil {
		log.Fatalf("failed creating users dir: %v", err)
	}

	sharesFile := filepath.Join(opts.OptionsDir, "shares.json")
	if err := os.MkdirAll(filepath.Dir(sharesFile), 0o755); err != nil {
		log.Fatalf("failed creating shares dir: %v", err)
	}

	s := &Server{
		notesBaseDir:        opts.Notes,
		clientDir:           opts.Client,
		usersFile:           opts.UsersFile,
		apiKeysFile:         opts.APIKeysFile,
		sharesFile:          sharesFile,
		shares:              make(map[string]ShareRecord),
		sessions:            make(map[string]Session),
		hub:                 NewHub(),
		recentChangeOrigins: NewRecentChangeOrigins(),
	}

	if err := s.loadShares(); err != nil {
		log.Fatalf("failed loading shares: %v", err)
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

	mux.HandleFunc("/client-api/me", s.handleMe)
	mux.HandleFunc("/client-api/me/password", s.handleChangePassword)
	mux.HandleFunc("/client-api/notes", s.handleNotes)
	mux.HandleFunc("/client-api/notes/", s.handleNoteByTitle)
	mux.HandleFunc("/client-api/ws", s.handleWebSocket)
	mux.HandleFunc("/client-api/share/", s.handleSharedNoteAPI)

	mux.HandleFunc("/api", s.handleAgentAPI)
	mux.HandleFunc("/api/notes", s.handleAgentNotes)
	mux.HandleFunc("/api/notes/", s.handleAgentNoteByPath)
	mux.HandleFunc("/api/search", s.handleAgentSearch)
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("/api/", s.handleAPINotFound)
	mux.HandleFunc("/client-api/", s.handleAPINotFound)
	mux.HandleFunc("/share/", s.handleSharePage)
	mux.HandleFunc("/", s.handleSPA)

	log.Printf("kladde listening on %s, notes=%s, client=%s, gitBackup=%t", opts.Addr, opts.Notes, opts.Client, opts.GitBackup.Enabled)
	if err := http.ListenAndServe(opts.Addr, loggingMiddleware(mux)); err != nil {
		log.Fatal(err)
	}
}
