# kladde

Kladde is an agent-friendly notes app that syncs to a folder with plain markdown files. Kladde is Danish for draft and sounds kind of like Clawd if you squint hard enough.


## Features

- **Offline-first** — IndexedDB cache with background sync and retry with exponential backoff
- **WYSIWYG + Markdown** — Tiptap editor with toggle to plain markdown mode
- **Task lists** — Clickable checkboxes
- **Star notes** — Starred notes float to top with smooth FLIP animation
- **Search** — Filter by title and content with highlighted snippets
- **Auto-save** — No save button, status shown as subtle icon (synced/syncing/offline/error)
- **Mobile-optimized** — Full-screen list ↔ editor with slide transitions, no hover on touch
- **Editable titles** — Rename notes inline, server auto-deduplicates with `(n)` suffix
- **Delete notes** — Via ⋮ menu with confirmation
- **Dark mode** — Respects system preference
- **PWA** — Installable, works offline, service worker with precaching

## Stack

- **Frontend:** Vue 3, TypeScript (strict), Tiptap, Pinia, Vue Router, Vite, Workbox
- **Backend:** Go — serves API + built PWA, stores notes as plain `.md` files
- **Icons:** Lucide

## Structure

```
client/   Vue + Vite PWA
server/   Go server
```

## Prerequisites

- Node.js + npm (for `client/`)
- Go 1.22+ (for `server/`)

## Build

From repo root:

```bash
# Build frontend
cd client
npm ci
npm run build

# Build backend
cd ../server
mkdir -p dist
go build -o ./dist/kladde-server .
```

This produces:

- Frontend static assets in `client/dist`
- Server binary in `server/dist/kladde-server`

## Options file (JSON)

The server reads runtime configuration from a JSON options file.
For normal startup, `-options <file>` is the only runtime CLI argument.

Example production file (`/etc/kladde/options.json`):

```json
{
  "addr": ":8080",
  "notes": "/var/data/kladde/notes",
  "client": "/var/www/kladde/client/dist",
  "users": "/var/data/kladde/users.json",
  "gitBackup": {
    "enabled": true,
    "remote": "https://github.com/your-org/kladde-backup.git",
    "githubToken": "ghp_your_personal_access_token",
    "authorName": "kladde backup",
    "authorEmail": "kladde@localhost"
  }
}
```

Fields:

- `addr` — HTTP listen address
- `notes` — path to notes directory
- `client` — path to built frontend assets (`client/dist`)
- `users` — path to `users.json`
- `gitBackup.enabled` — enable automatic git commit + push backups
- `gitBackup` always commits from the `notes` path
- `gitBackup.remote` — git remote URL (required when `gitBackup.enabled=true`)
- `gitBackup.githubToken` — GitHub personal access token used for authenticated push (with a GitHub remote)
- `gitBackup.authorName` / `gitBackup.authorEmail` — commit author identity

Backup behavior:

- Backup runs automatically on note changes
- Pushes target the remote's default branch (`origin/HEAD`)
- If `gitBackup.githubToken` is set, HTTPS GitHub auth uses that token
- Pushes are rate-limited to **at most once per minute**

## Run locally

From repo root:

```bash
mkdir -p tmp/notes tmp/data
cat > tmp/options.json <<'JSON'
{
  "addr": "127.0.0.1:8080",
  "notes": "./tmp/notes",
  "client": "./client/dist",
  "users": "./tmp/data/users.json"
}
JSON

./server/dist/kladde-server -options ./tmp/options.json
```

Health check:

```bash
curl http://127.0.0.1:8080/api/health
```

## Create first user

Before logging in, create a user (use the same `users` path as in your options file):

```bash
./server/dist/kladde-server adduser \
  --users ./tmp/data/users.json \
  --username admin \
  --password "<choose-a-strong-password>" \
  --name "Admin"
```

## Deploy (production)

```bash
# Build client
cd client && npm run build

# Build + deploy server
cd ../server && go build -o server .
sudo systemctl stop kladde
sudo cp server /usr/local/bin/kladde
sudo systemctl start kladde
```

Served via nginx reverse proxy.
