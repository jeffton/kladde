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

	p, err := s.notePath(dir, "normal-title")
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
		"users":  "./data/users.json",
	}
	data, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write options: %v", err)
	}

	opts, err := loadOptions(path)
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
	if opts.Users != "data/users.json" {
		t.Fatalf("unexpected users path: %q", opts.Users)
	}
}

func TestLoadOptionsRejectsUnknownFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "options.json")

	if err := os.WriteFile(path, []byte(`{"addr":":8080","unknown":true}`), 0o644); err != nil {
		t.Fatalf("write options: %v", err)
	}

	if _, err := loadOptions(path); err == nil {
		t.Fatal("expected loadOptions to fail on unknown fields")
	}
}
