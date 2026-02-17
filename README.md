# kladde

A minimal, offline-first note-taking PWA with a warm, Notion-inspired aesthetic.

**Live:** [<redacted-domain>](https://<redacted-domain>)

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

## Build

```bash
cd client && npm install && npm run build
cd ../server && go build
```

## Run

```bash
./server -addr :8080 -notes /var/data/kladde/notes/ -dist ../client/dist
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
