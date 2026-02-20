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
	Enabled     bool   `json:"enabled"`
	Remote      string `json:"remote"`
	AuthorName  string `json:"authorName"`
	AuthorEmail string `json:"authorEmail"`
}

type Options struct {
	Addr      string           `json:"addr"`
	Notes     string           `json:"notes"`
	Client    string           `json:"client"`
	Users     string           `json:"users"`
	GitBackup GitBackupOptions `json:"gitBackup"`
}

func defaultOptions() Options {
	return Options{
		Addr:   ":8080",
		Notes:  "/var/data/kladde/notes/",
		Client: "../client/dist",
		Users:  "/var/data/kladde/users.json",
		GitBackup: GitBackupOptions{
			Enabled:     false,
			Remote:      "",
			AuthorName:  "kladde backup",
			AuthorEmail: "kladde@localhost",
		},
	}
}

func loadOptions(path string) (Options, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return Options{}, errors.New("options file path is required")
	}

	data, err := os.ReadFile(path)
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
	if strings.TrimSpace(opts.Users) == "" {
		return Options{}, errors.New("options.users is required")
	}

	opts.Notes = filepath.Clean(opts.Notes)
	opts.Client = filepath.Clean(opts.Client)
	opts.Users = filepath.Clean(opts.Users)

	opts.GitBackup.Remote = strings.TrimSpace(opts.GitBackup.Remote)
	opts.GitBackup.AuthorName = strings.TrimSpace(opts.GitBackup.AuthorName)
	opts.GitBackup.AuthorEmail = strings.TrimSpace(opts.GitBackup.AuthorEmail)

	if opts.GitBackup.AuthorName == "" {
		return Options{}, errors.New("options.gitBackup.authorName is required")
	}
	if opts.GitBackup.AuthorEmail == "" {
		return Options{}, errors.New("options.gitBackup.authorEmail is required")
	}
	if opts.GitBackup.Enabled && opts.GitBackup.Remote == "" {
		return Options{}, errors.New("options.gitBackup.remote is required when gitBackup.enabled is true")
	}

	return opts, nil
}
