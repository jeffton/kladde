package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type GitBackupOptions struct {
	Enabled             bool   `json:"enabled"`
	Remote              string `json:"remote"`
	GitHubToken         string `json:"githubToken"`
	PushIntervalSeconds int    `json:"pushIntervalSeconds"`
	AuthorName          string `json:"authorName"`
	AuthorEmail         string `json:"authorEmail"`
}

type Options struct {
	Addr      string           `json:"addr"`
	Notes     string           `json:"notes"`
	Client    string           `json:"client"`
	GitBackup GitBackupOptions `json:"gitBackup"`

	OptionsDir string `json:"-"`
	UsersFile  string `json:"-"`
}

func defaultOptions() Options {
	return Options{
		Addr:   ":8080",
		Notes:  "/var/data/kladde/notes/",
		Client: "../client/dist",
		GitBackup: GitBackupOptions{
			Enabled:             false,
			Remote:              "",
			GitHubToken:         "",
			PushIntervalSeconds: 300,
			AuthorName:          "kladde backup",
			AuthorEmail:         "kladde@localhost",
		},
	}
}

func loadOptions(optionsDir string) (Options, error) {
	optionsDir = strings.TrimSpace(optionsDir)
	if optionsDir == "" {
		return Options{}, errors.New("options directory path is required")
	}

	optionsDir = filepath.Clean(optionsDir)
	info, err := os.Stat(optionsDir)
	if err != nil {
		return Options{}, fmt.Errorf("failed accessing options directory: %w", err)
	}
	if !info.IsDir() {
		return Options{}, errors.New("options path must be a directory")
	}

	optionsFile := filepath.Join(optionsDir, "options.json")
	data, err := os.ReadFile(optionsFile)
	if err != nil {
		return Options{}, fmt.Errorf("failed reading options file: %w", err)
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return Options{}, errors.New("options file is empty")
	}

	opts := defaultOptions()
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&opts); err != nil {
		return Options{}, fmt.Errorf("failed parsing options file: %w", err)
	}

	if strings.TrimSpace(opts.Addr) == "" {
		return Options{}, errors.New("options.addr is required")
	}
	if strings.TrimSpace(opts.Notes) == "" {
		return Options{}, errors.New("options.notes is required")
	}
	if strings.TrimSpace(opts.Client) == "" {
		return Options{}, errors.New("options.client is required")
	}

	opts.Notes = filepath.Clean(opts.Notes)
	opts.Client = filepath.Clean(opts.Client)
	opts.OptionsDir = optionsDir
	opts.UsersFile = filepath.Join(optionsDir, "users.json")

	opts.GitBackup.Remote = strings.TrimSpace(opts.GitBackup.Remote)
	opts.GitBackup.GitHubToken = strings.TrimSpace(opts.GitBackup.GitHubToken)
	opts.GitBackup.AuthorName = strings.TrimSpace(opts.GitBackup.AuthorName)
	opts.GitBackup.AuthorEmail = strings.TrimSpace(opts.GitBackup.AuthorEmail)

	if opts.GitBackup.AuthorName == "" {
		return Options{}, errors.New("options.gitBackup.authorName is required")
	}
	if opts.GitBackup.AuthorEmail == "" {
		return Options{}, errors.New("options.gitBackup.authorEmail is required")
	}
	if opts.GitBackup.PushIntervalSeconds <= 0 {
		return Options{}, errors.New("options.gitBackup.pushIntervalSeconds must be greater than 0")
	}
	if opts.GitBackup.Enabled && opts.GitBackup.Remote == "" {
		return Options{}, errors.New("options.gitBackup.remote is required when gitBackup.enabled is true")
	}

	return opts, nil
}
