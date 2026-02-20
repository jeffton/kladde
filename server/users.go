package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

func runAddUser(args []string) error {
	fs := flag.NewFlagSet("adduser", flag.ContinueOnError)
	username := fs.String("username", "", "Username")
	password := fs.String("password", "", "Password")
	name := fs.String("name", "", "Display name")
	usersFile := fs.String("users", "/var/data/kladde/users.json", "Path to users.json")

	if err := fs.Parse(args); err != nil {
		return err
	}

	*username = strings.TrimSpace(*username)
	*password = strings.TrimSpace(*password)
	*name = strings.TrimSpace(*name)

	if *username == "" || *password == "" || *name == "" {
		return errors.New("usage: kladde adduser --username <username> --password <password> --name \"Display Name\"")
	}

	if err := os.MkdirAll(filepath.Dir(*usersFile), 0o755); err != nil {
		return fmt.Errorf("failed creating users dir: %w", err)
	}

	users, err := loadUsers(*usersFile)
	if err != nil {
		return err
	}

	for _, u := range users {
		if u.Username == *username {
			return fmt.Errorf("user %q already exists", *username)
		}
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(*password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed hashing password: %w", err)
	}

	users = append(users, UserRecord{
		Username:     *username,
		PasswordHash: string(hash),
		DisplayName:  *name,
	})

	if err := saveUsers(*usersFile, users); err != nil {
		return err
	}

	log.Printf("user %q added", *username)
	return nil
}

func loadUsers(path string) ([]UserRecord, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []UserRecord{}, nil
		}
		return nil, fmt.Errorf("failed reading users file: %w", err)
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return []UserRecord{}, nil
	}

	var users []UserRecord
	if err := json.Unmarshal(data, &users); err != nil {
		return nil, fmt.Errorf("failed parsing users file: %w", err)
	}
	return users, nil
}

func saveUsers(path string, users []UserRecord) error {
	data, err := json.MarshalIndent(users, "", "  ")
	if err != nil {
		return fmt.Errorf("failed serializing users: %w", err)
	}
	data = append(data, '\n')

	if err := writeFileAtomic(path, data, 0o600); err != nil {
		return fmt.Errorf("failed writing users file: %w", err)
	}
	return nil
}
