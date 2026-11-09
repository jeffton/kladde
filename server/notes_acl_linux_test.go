package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestNoteWritesPreserveInheritedACLAccess(t *testing.T) {
	if _, err := exec.LookPath("setfacl"); err != nil {
		t.Skip("POSIX ACL tools are required")
	}

	dir := os.Getenv("KLADDE_ACL_TEST_DIR")
	if dir == "" {
		dir = t.TempDir()
	}
	uid := os.Getenv("KLADDE_ACL_TEST_UID")
	if uid == "" {
		uid = strconv.Itoa(os.Getuid())
	}
	acl := "u:" + uid + ":rwx,m::rwx,d:u::rwx,d:u:" + uid + ":rwx,d:g::r-x,d:m::rwx,d:o::r-x"
	if output, err := exec.Command("setfacl", "-m", acl, dir).CombinedOutput(); err != nil {
		t.Fatalf("set inherited ACL: %v: %s", err, output)
	}

	assertSharedAccess := func(path string, directory bool) {
		t.Helper()
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		wantMask := os.FileMode(0o060)
		if directory {
			wantMask = 0o070
		}
		if info.Mode().Perm()&0o070 != wantMask {
			t.Fatalf("%s: ACL mask %03o, want %03o", path, info.Mode().Perm()&0o070, wantMask)
		}
		output, err := exec.Command("getfacl", "-cpn", path).CombinedOutput()
		if err != nil {
			t.Fatalf("get ACL: %v: %s", err, output)
		}
		if !strings.Contains(string(output), "user:"+uid+":rwx") {
			t.Fatalf("%s: missing inherited collaborator ACL: %s", path, output)
		}
		if info.Mode().Perm()&0o002 != 0 {
			t.Fatalf("%s: must not be world-writable", path)
		}
	}

	s := &Server{}
	if _, err := s.createNote(dir, "Access probe", "collection", "created"); err != nil {
		t.Fatal(err)
	}
	collection := filepath.Join(dir, "collection")
	note := filepath.Join(collection, "Access probe.md")
	assertSharedAccess(collection, true)
	assertSharedAccess(note, false)
	if _, _, err := s.saveNote(dir, "Access probe", "collection", "updated"); err != nil {
		t.Fatal(err)
	}
	assertSharedAccess(note, false)
	if err := saveStars(dir, map[string]bool{"collection/Access probe": true}); err != nil {
		t.Fatal(err)
	}
	assertSharedAccess(filepath.Join(dir, ".stars.json"), false)
	if _, err := s.renameNote(dir, "Access probe", "collection", "Access probe", "moved"); err != nil {
		t.Fatal(err)
	}
	assertSharedAccess(filepath.Join(dir, "moved"), true)
	assertSharedAccess(filepath.Join(dir, "moved", "Access probe.md"), false)
	assertSharedAccess(filepath.Join(dir, ".stars.json"), false)
}
