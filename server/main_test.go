package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateTitle(t *testing.T) {
	cases := []struct {
		name    string
		title   string
		wantErr bool
	}{
		{name: "valid", title: "My Note", wantErr: false},
		{name: "empty", title: "", wantErr: true},
		{name: "slash", title: "a/b", wantErr: true},
		{name: "backslash", title: `a\\b`, wantErr: true},
		{name: "dotdot", title: "..", wantErr: true},
		{name: "control", title: "hello\nworld", wantErr: true},
		{name: "too long", title: strings.Repeat("a", maxTitleLength+1), wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateTitle(tc.title)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
		})
	}
}

func TestNotePathStaysInsideNotesDir(t *testing.T) {
	dir := t.TempDir()
	s := &Server{}

	p, err := s.notePath(dir, "normal-title", "")
	if err != nil {
		t.Fatalf("notePath returned unexpected error: %v", err)
	}

	if !strings.HasPrefix(p, dir+string(os.PathSeparator)) {
		t.Fatalf("expected path %q to be inside %q", p, dir)
	}
	if filepath.Base(p) != "normal-title.md" {
		t.Fatalf("unexpected file name: %q", filepath.Base(p))
	}
}

func TestNotePathRejectsSymlinkCollectionDir(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	linkPath := filepath.Join(dir, "shared")
	if err := os.Symlink(outside, linkPath); err != nil {
		t.Skipf("symlink creation not supported: %v", err)
	}

	s := &Server{}
	if _, err := s.notePath(dir, "normal-title", "shared"); err == nil {
		t.Fatal("expected notePath to reject symlink collection dir")
	}
}

func TestValidateCollection(t *testing.T) {
	cases := []struct {
		name       string
		collection string
		wantErr    bool
	}{
		{name: "empty", collection: "", wantErr: false},
		{name: "valid", collection: "opskrifter", wantErr: false},
		{name: "slash", collection: "mad/pasta", wantErr: true},
		{name: "dotdot", collection: "..", wantErr: true},
		{name: "control", collection: "rejser\n", wantErr: true},
		{name: "too long", collection: strings.Repeat("a", maxCollectionLength+1), wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateCollection(tc.collection)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
		})
	}
}

func TestParseUserNoteRelPath(t *testing.T) {
	title, collection, ok := parseUserNoteRelPath(filepath.Join("opskrifter", "pasta.md"))
	if !ok {
		t.Fatal("expected collection note path to parse")
	}
	if title != "pasta" || collection != "opskrifter" {
		t.Fatalf("unexpected parse result: title=%q collection=%q", title, collection)
	}

	title, collection, ok = parseUserNoteRelPath("rodniveau.md")
	if !ok {
		t.Fatal("expected root note path to parse")
	}
	if title != "rodniveau" || collection != "" {
		t.Fatalf("unexpected parse result for root note: title=%q collection=%q", title, collection)
	}
}

func TestCreateNoteAutoAppendsWithinCollection(t *testing.T) {
	dir := t.TempDir()
	s := &Server{}

	first, err := s.createNote(dir, "Pasta", "opskrifter", "første")
	if err != nil {
		t.Fatalf("createNote first failed: %v", err)
	}
	if first.Title != "Pasta" {
		t.Fatalf("unexpected first title: %q", first.Title)
	}

	second, err := s.createNote(dir, "Pasta", "opskrifter", "anden")
	if err != nil {
		t.Fatalf("createNote second failed: %v", err)
	}
	if second.Title != "Pasta (2)" {
		t.Fatalf("expected deduplicated title, got %q", second.Title)
	}

	root, err := s.createNote(dir, "Pasta", "", "rod")
	if err != nil {
		t.Fatalf("createNote root failed: %v", err)
	}
	if root.Title != "Pasta" || root.Collection != "" {
		t.Fatalf("expected root-level Pasta note, got title=%q collection=%q", root.Title, root.Collection)
	}
}

func TestSaveAndLoadUsersRoundTrip(t *testing.T) {
	dir := t.TempDir()
	usersFile := filepath.Join(dir, "users.json")

	in := []UserRecord{{
		Username:     "david",
		PasswordHash: "hash",
		DisplayName:  "David",
	}}

	if err := saveUsers(usersFile, in); err != nil {
		t.Fatalf("saveUsers failed: %v", err)
	}

	out, err := loadUsers(usersFile)
	if err != nil {
		t.Fatalf("loadUsers failed: %v", err)
	}

	if len(out) != 1 {
		t.Fatalf("expected 1 user, got %d", len(out))
	}
	if out[0].Username != in[0].Username || out[0].DisplayName != in[0].DisplayName || out[0].PasswordHash != in[0].PasswordHash {
		t.Fatalf("loaded user mismatch: got %+v want %+v", out[0], in[0])
	}
}

func TestDecodeJSONBodyRejectsUnknownFields(t *testing.T) {
	body := `{"title":"hello","extra":"nope"}`
	req := httptest.NewRequest("POST", "/", strings.NewReader(body))
	w := httptest.NewRecorder()

	var payload struct {
		Title string `json:"title"`
	}

	err := decodeJSONBody(w, req, &payload)
	if err == nil {
		t.Fatal("expected error for unknown field, got nil")
	}
}

func TestLoadOptionsDefaultsAndOverrides(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "options.json")

	raw := map[string]string{
		"addr":   "127.0.0.1:9090",
		"notes":  "./notes",
		"client": "./client/dist",
	}
	data, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write options: %v", err)
	}

	opts, err := loadOptions(dir)
	if err != nil {
		t.Fatalf("loadOptions failed: %v", err)
	}

	if opts.Addr != "127.0.0.1:9090" {
		t.Fatalf("unexpected addr: %q", opts.Addr)
	}
	if opts.Notes != "notes" {
		t.Fatalf("unexpected notes path: %q", opts.Notes)
	}
	if opts.Client != "client/dist" {
		t.Fatalf("unexpected client path: %q", opts.Client)
	}
	if opts.OptionsDir != dir {
		t.Fatalf("unexpected options dir: %q", opts.OptionsDir)
	}
	if opts.UsersFile != filepath.Join(dir, "users.json") {
		t.Fatalf("unexpected users file path: %q", opts.UsersFile)
	}
	if opts.APIKeysFile != filepath.Join(dir, "apikeys.json") {
		t.Fatalf("unexpected api keys file path: %q", opts.APIKeysFile)
	}
	if opts.GitBackup.PushIntervalSeconds != 300 {
		t.Fatalf("unexpected default git backup interval: %d", opts.GitBackup.PushIntervalSeconds)
	}
}

func TestLoadOptionsRejectsUnknownFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "options.json")

	if err := os.WriteFile(path, []byte(`{"addr":":8080","unknown":true}`), 0o644); err != nil {
		t.Fatalf("write options: %v", err)
	}

	if _, err := loadOptions(dir); err == nil {
		t.Fatal("expected loadOptions to fail on unknown fields")
	}
}

func TestLoadOptionsGitBackupRequiresRemoteWhenEnabled(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "options.json")

	if err := os.WriteFile(path, []byte(`{"gitBackup":{"enabled":true}}`), 0o644); err != nil {
		t.Fatalf("write options: %v", err)
	}

	if _, err := loadOptions(dir); err == nil {
		t.Fatal("expected loadOptions to fail when git backup is enabled without remote")
	}
}

func TestLoadOptionsRejectsInvalidGitBackupInterval(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "options.json")

	if err := os.WriteFile(path, []byte(`{"gitBackup":{"pushIntervalSeconds":0}}`), 0o644); err != nil {
		t.Fatalf("write options: %v", err)
	}

	if _, err := loadOptions(dir); err == nil {
		t.Fatal("expected loadOptions to fail when git backup interval is invalid")
	}
}
