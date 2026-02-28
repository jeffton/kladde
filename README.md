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
For normal startup, `--options <directory>` is the only runtime CLI argument (it loads `<directory>/options.json`).

Example production file (`/etc/kladde/options.json`):

```json
{
  "addr": ":8080",
  "notes": "/var/data/kladde/notes",
  "client": "/var/www/kladde/client/dist",
  "gitBackup": {
    "enabled": true,
    "remote": "https://github.com/your-org/kladde-backup.git",
    "githubToken": "ghp_your_personal_access_token",
    "pushIntervalSeconds": 300,
    "authorName": "kladde backup",
    "authorEmail": "kladde@localhost"
  }
}
```

Fields:

- `addr` — HTTP listen address
- `notes` — path to notes directory
- `client` — path to built frontend assets (`client/dist`)
- `gitBackup.enabled` — enable automatic git commit + push backups
- `gitBackup.remote` — git remote URL (required when `gitBackup.enabled=true`)
- `gitBackup.githubToken` *(optional)* — GitHub personal access token for authenticated push (see [Creating a GitHub token](#creating-a-github-token))
- `gitBackup.pushIntervalSeconds` *(optional, default `300`)* — minimum seconds between push attempts
- `gitBackup.authorName` / `gitBackup.authorEmail` — commit author identity

Derived paths (not configurable in `options.json`):

- `<options-dir>/users.json`
- `<options-dir>/shares.json`

Backup behavior:

- Backup runs automatically on note changes
- Pushes target the remote's default branch (`origin/HEAD`)
- If `gitBackup.githubToken` is set, HTTPS GitHub auth uses that token
- If `gitBackup.githubToken` is not set, git falls back to normal host auth (SSH keys, credential helper, etc.)
- Pushes are rate-limited by `gitBackup.pushIntervalSeconds` (default **5 minutes**)

### Creating a GitHub token

To use `gitBackup` with a GitHub remote, you need a **fine-grained personal access token**:

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
2. **Name:** e.g. `kladde-backup`
3. **Expiration:** pick what suits you (up to "no expiration")
4. **Repository access:** "Only select repositories" → pick your backup repo
5. **Permissions → Repository permissions:** Contents → **Read and write**
6. Click **Generate token** and copy it into `gitBackup.githubToken` in your options file

No other permissions or scopes are needed.

## Run locally

From repo root:

```bash
mkdir -p tmp/notes
cat > tmp/options.json <<'JSON'
{
  "addr": "127.0.0.1:8080",
  "notes": "./tmp/notes",
  "client": "./client/dist"
}
JSON

./server/dist/kladde-server --options ./tmp
```

Health check:

```bash
curl http://127.0.0.1:8080/api/health
```

## API layout

- `/client-api/*` — web app API (cookie/session auth)
- `/api/*` — agent API (Bearer token auth, markdown-first)

Agent API is self-documenting:

```bash
curl http://127.0.0.1:8080/api
```

## Create first user

Before logging in, create a user (`users.json` lives in the options directory):

```bash
./server/dist/kladde-server adduser \
  --users ./tmp/users.json \
  --username admin \
  --password "<choose-a-strong-password>" \
  --name "Admin"
```

## Create an agent API key

API keys are stored in `apikeys.json` in the options directory.
The command prints the token once (copy it immediately):

```bash
./server/dist/kladde-server addapikey \
  --keys ./tmp/apikeys.json \
  --username admin \
  --name "my-agent" \
  --readonly
```

Example usage:

```bash
TOKEN="kld_..."

# List notes
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/notes

# Create/update a note inside collection "opskrifter"
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/markdown" \
  --data-binary $'# Carbonara\n\n- Æg' \
  http://127.0.0.1:8080/api/notes/opskrifter/carbonara

# Rename/move a note
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"opskrifter/carbonara","to":"aftensmad/carbonara"}' \
  http://127.0.0.1:8080/api/move
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

Optionally served behind a reverse proxy (nginx, Caddy, etc.) for TLS and domain routing.
