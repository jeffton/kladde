package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const gitBackupMinPushInterval = time.Minute

type GitBackup struct {
	repo          string
	opts          GitBackupOptions
	remoteURL     string
	defaultBranch string

	mu              sync.Mutex
	pending         bool
	pendingReason   string
	running         bool
	scheduled       bool
	lastPushAttempt time.Time
}

func NewGitBackup(repo string, opts GitBackupOptions) (*GitBackup, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return nil, fmt.Errorf("git executable not found: %w", err)
	}

	repo = filepath.Clean(repo)
	if err := os.MkdirAll(repo, 0o755); err != nil {
		return nil, fmt.Errorf("failed creating git backup repo dir: %w", err)
	}

	remoteURL, err := normalizeGitHubRemote(opts.Remote, opts.GitHubToken)
	if err != nil {
		return nil, err
	}

	g := &GitBackup{repo: repo, opts: opts, remoteURL: remoteURL}
	if err := g.prepareRepo(); err != nil {
		return nil, err
	}

	return g, nil
}

func (g *GitBackup) prepareRepo() error {
	if _, err := os.Stat(filepath.Join(g.repo, ".git")); err != nil {
		if os.IsNotExist(err) {
			if _, err := g.runGit("init"); err != nil {
				return fmt.Errorf("failed to initialize git repo: %w", err)
			}
		} else {
			return fmt.Errorf("failed to inspect git repo: %w", err)
		}
	}

	if _, err := g.runGit("config", "user.name", g.opts.AuthorName); err != nil {
		return fmt.Errorf("failed to configure git user.name: %w", err)
	}
	if _, err := g.runGit("config", "user.email", g.opts.AuthorEmail); err != nil {
		return fmt.Errorf("failed to configure git user.email: %w", err)
	}

	if err := g.setRemote("origin", g.remoteURL); err != nil {
		return err
	}

	branch, err := g.resolveDefaultBranch()
	if err != nil {
		return err
	}
	g.defaultBranch = branch

	if _, err := g.runGit("checkout", "-B", g.defaultBranch); err != nil {
		return fmt.Errorf("failed to switch to default branch %q: %w", g.defaultBranch, err)
	}

	return nil
}

func (g *GitBackup) setRemote(name, url string) error {
	out, err := g.runGit("remote", "get-url", name)
	if err != nil {
		if _, addErr := g.runGit("remote", "add", name, url); addErr != nil {
			return fmt.Errorf("failed to add git remote %q: %w", name, addErr)
		}
		return nil
	}
	if strings.TrimSpace(out) == url {
		return nil
	}
	if _, err := g.runGit("remote", "set-url", name, url); err != nil {
		return fmt.Errorf("failed to set git remote %q: %w", name, err)
	}
	return nil
}

func (g *GitBackup) resolveDefaultBranch() (string, error) {
	out, err := g.runGit("ls-remote", "--symref", "origin", "HEAD")
	if err != nil {
		return "", fmt.Errorf("failed resolving remote default branch: %w", err)
	}

	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "ref: ") || !strings.HasSuffix(line, "HEAD") {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		ref := strings.TrimSpace(parts[1])
		if strings.HasPrefix(ref, "refs/heads/") {
			return strings.TrimPrefix(ref, "refs/heads/"), nil
		}
	}

	return "", fmt.Errorf("failed parsing default branch from remote HEAD")
}

func normalizeGitHubRemote(remote, token string) (string, error) {
	remote = strings.TrimSpace(remote)
	token = strings.TrimSpace(token)
	if token == "" {
		return remote, nil
	}

	switch {
	case strings.HasPrefix(remote, "https://github.com/"):
		return remote, nil
	case strings.HasPrefix(remote, "git@github.com:"):
		return "https://github.com/" + strings.TrimPrefix(remote, "git@github.com:"), nil
	case strings.HasPrefix(remote, "ssh://git@github.com/"):
		return "https://github.com/" + strings.TrimPrefix(remote, "ssh://git@github.com/"), nil
	default:
		return "", fmt.Errorf("options.gitBackup.githubToken requires a github.com remote URL")
	}
}

func (g *GitBackup) Trigger(reason string) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "change"
	}

	g.mu.Lock()
	g.pending = true
	g.pendingReason = reason
	if g.running || g.scheduled {
		g.mu.Unlock()
		return
	}
	delay := g.nextDelayLocked(time.Now())
	g.scheduled = true
	g.mu.Unlock()

	time.AfterFunc(delay, g.run)
}

func (g *GitBackup) nextDelayLocked(now time.Time) time.Duration {
	if g.lastPushAttempt.IsZero() {
		return 0
	}
	next := g.lastPushAttempt.Add(gitBackupMinPushInterval)
	if now.After(next) {
		return 0
	}
	return time.Until(next)
}

func (g *GitBackup) run() {
	g.mu.Lock()
	if g.running {
		g.scheduled = false
		g.mu.Unlock()
		return
	}
	reason := g.pendingReason
	g.pending = false
	g.pendingReason = ""
	g.running = true
	g.scheduled = false
	g.mu.Unlock()

	err := g.backupOnce(reason)
	if err != nil {
		log.Printf("git backup failed: %v", err)
		g.mu.Lock()
		g.pending = true
		if g.pendingReason == "" {
			g.pendingReason = reason
		}
		g.mu.Unlock()
	}

	g.mu.Lock()
	g.running = false
	shouldSchedule := g.pending && !g.scheduled
	delay := g.nextDelayLocked(time.Now())
	if shouldSchedule {
		g.scheduled = true
	}
	g.mu.Unlock()

	if shouldSchedule {
		time.AfterFunc(delay, g.run)
	}
}

func (g *GitBackup) backupOnce(reason string) error {
	if _, err := g.runGit("add", "-A"); err != nil {
		return fmt.Errorf("git add failed: %w", err)
	}

	if err := g.hasStagedChanges(); err != nil {
		if err == errNoStagedChanges {
			return nil
		}
		return fmt.Errorf("failed checking staged changes: %w", err)
	}

	msg := fmt.Sprintf("kladde backup: %s (%s)", reason, time.Now().Format(time.RFC3339))
	if _, err := g.runGit("commit", "-m", msg); err != nil {
		return fmt.Errorf("git commit failed: %w", err)
	}

	g.mu.Lock()
	g.lastPushAttempt = time.Now()
	g.mu.Unlock()

	if _, err := g.runGit("push", "-u", "origin", g.defaultBranch); err != nil {
		return fmt.Errorf("git push failed: %w", err)
	}

	return nil
}

var errNoStagedChanges = fmt.Errorf("no staged changes")

func (g *GitBackup) hasStagedChanges() error {
	cmd := exec.Command("git", "-C", g.repo, "diff", "--cached", "--quiet")
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil
		}
		return err
	}
	return errNoStagedChanges
}

func (g *GitBackup) runGit(args ...string) (string, error) {
	gitArgs := []string{"-C", g.repo}
	if strings.TrimSpace(g.opts.GitHubToken) != "" {
		auth := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + g.opts.GitHubToken))
		gitArgs = append(gitArgs, "-c", "http.https://github.com/.extraheader=AUTHORIZATION: basic "+auth)
	}
	gitArgs = append(gitArgs, args...)

	cmd := exec.Command("git", gitArgs...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		combined := strings.TrimSpace(stdout.String() + "\n" + stderr.String())
		if combined == "" {
			combined = err.Error()
		}
		return "", fmt.Errorf("%s (%s)", strings.Join(args, " "), combined)
	}
	return strings.TrimSpace(stdout.String()), nil
}
