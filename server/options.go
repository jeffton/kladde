package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Options struct {
	Addr   string `json:"addr"`
	Notes  string `json:"notes"`
	Client string `json:"client"`
	Users  string `json:"users"`
}

func defaultOptions() Options {
	return Options{
		Addr:   ":8080",
		Notes:  "/var/data/kladde/notes/",
		Client: "../client/dist",
		Users:  "/var/data/kladde/users.json",
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

	return opts, nil
}
