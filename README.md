# noteapp

Prototype note app with:
- Go backend serving API and built Vue PWA
- Markdown files as storage (`title = filename`)
- Offline-first PWA with Pinia state
- WYSIWYG markdown editor + plain markdown toggle
- Pinned notes + latest-updated sorting

## Structure
- `client/` Vue + Vite PWA
- `server/` Go server

## Build
```bash
cd client && npm install && npm run build
cd ../server && go build
```

## Run server
```bash
./server -addr :8080 -notes /var/data/noteapp/notes/ -dist ../client/dist
```
