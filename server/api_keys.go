package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

func runAddAPIKey(args []string) error {
	fs := flag.NewFlagSet("addapikey", flag.ContinueOnError)
	username := fs.String("username", "", "Username this API key should access")
	name := fs.String("name", "", "Display name for the API key")
	readOnly := fs.Bool("readonly", false, "Create a read-only API key")
	keysFile := fs.String("keys", "/var/data/kladde/apikeys.json", "Path to apikeys.json")

	if err := fs.Parse(args); err != nil {
		return err
	}

	*username = strings.TrimSpace(*username)
	*name = strings.TrimSpace(*name)

	if *username == "" || *name == "" {
		return errors.New("usage: kladde addapikey --username <username> --name \"Agent Name\" [--readonly] [--keys <path>]")
	}

	if err := os.MkdirAll(filepath.Dir(*keysFile), 0o755); err != nil {
		return fmt.Errorf("failed creating api keys dir: %w", err)
	}

	keys, err := loadAPIKeys(*keysFile)
	if err != nil {
		return err
	}

	id := ""
	for id == "" {
		rawID, err := randomToken(6)
		if err != nil {
			return fmt.Errorf("failed creating key id: %w", err)
		}
		candidate := strings.TrimSpace(rawID)
		exists := false
		for _, key := range keys {
			if key.ID == candidate {
				exists = true
				break
			}
		}
		if !exists {
			id = candidate
		}
	}

	secret, err := randomToken(24)
	if err != nil {
		return fmt.Errorf("failed creating key secret: %w", err)
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(secret), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed hashing api key: %w", err)
	}

	keys = append(keys, APIKeyRecord{
		ID:           id,
		Name:         *name,
		Username:     *username,
		PasswordHash: string(hash),
		ReadOnly:     *readOnly,
	})

	if err := saveAPIKeys(*keysFile, keys); err != nil {
		return err
	}

	fmt.Printf("kld_%s.%s\n", id, secret)
	return nil
}

func loadAPIKeys(path string) ([]APIKeyRecord, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []APIKeyRecord{}, nil
		}
		return nil, fmt.Errorf("failed reading api keys file: %w", err)
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return []APIKeyRecord{}, nil
	}

	var keys []APIKeyRecord
	if err := json.Unmarshal(data, &keys); err != nil {
		return nil, fmt.Errorf("failed parsing api keys file: %w", err)
	}
	return keys, nil
}

func saveAPIKeys(path string, keys []APIKeyRecord) error {
	data, err := json.MarshalIndent(keys, "", "  ")
	if err != nil {
		return fmt.Errorf("failed serializing api keys: %w", err)
	}
	data = append(data, '\n')

	if err := writeFileAtomic(path, data, 0o600); err != nil {
		return fmt.Errorf("failed writing api keys file: %w", err)
	}
	return nil
}

func parseAgentToken(token string) (string, string, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return "", "", errors.New("missing bearer token")
	}
	if !strings.HasPrefix(token, "kld_") {
		return "", "", errors.New("invalid bearer token")
	}

	token = strings.TrimPrefix(token, "kld_")
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return "", "", errors.New("invalid bearer token")
	}

	id := strings.TrimSpace(parts[0])
	secret := strings.TrimSpace(parts[1])
	if id == "" || secret == "" {
		return "", "", errors.New("invalid bearer token")
	}
	return id, secret, nil
}

func readBearerToken(r *http.Request) (string, error) {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if header == "" {
		return "", errors.New("missing authorization header")
	}
	if !strings.HasPrefix(header, "Bearer ") {
		return "", errors.New("invalid authorization header")
	}
	return strings.TrimSpace(strings.TrimPrefix(header, "Bearer ")), nil
}

func (s *Server) requireAPIKey(w http.ResponseWriter, r *http.Request) (APIPrincipal, bool) {
	token, err := readBearerToken(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, errors.New("unauthorized"))
		return APIPrincipal{}, false
	}

	id, secret, err := parseAgentToken(token)
	if err != nil {
		writeError(w, http.StatusUnauthorized, errors.New("unauthorized"))
		return APIPrincipal{}, false
	}

	keys, err := loadAPIKeys(s.apiKeysFile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, errors.New("failed loading api keys"))
		return APIPrincipal{}, false
	}

	for _, key := range keys {
		if key.ID != id {
			continue
		}
		if bcrypt.CompareHashAndPassword([]byte(key.PasswordHash), []byte(secret)) != nil {
			break
		}
		return APIPrincipal{
			KeyID:    key.ID,
			Name:     key.Name,
			Username: key.Username,
			ReadOnly: key.ReadOnly,
		}, true
	}

	writeError(w, http.StatusUnauthorized, errors.New("unauthorized"))
	return APIPrincipal{}, false
}
