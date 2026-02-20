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
go build -o ../tmp/kladde-server .
```

This produces:

- Frontend static assets in `client/dist`
- Server binary in `tmp/kladde-server`

## Run locally

From repo root:

```bash
mkdir -p tmp/notes tmp/data
./tmp/kladde-server \
  -addr 127.0.0.1:8080 \
  -notes ./tmp/notes \
  -users ./tmp/data/users.json \
  -dist ./client/dist
```

Health check:

```bash
curl http://127.0.0.1:8080/api/health
```

## Create first user

Before logging in, create a user:

```bash
./tmp/kladde-server adduser \
  --users ./tmp/data/users.json \
  --username admin \
  --password changeme \
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

Served via nginx reverse proxy on `<redacted-domain>`.
