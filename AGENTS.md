# AGENTS.md — kladde

## Screenshots
When taking screenshots (Playwright, QA, etc.), save them in `screenshots/` (gitignored).
Do NOT save screenshots in the project root or other directories.

## Build & Deploy
```bash
cd client && npm run build && sudo rsync -a --delete-delay --delay-updates --chown=kladde:kladde dist/ /var/lib/kladde/dist/
cd ../server && go build -o server .
sudo systemctl stop kladde
sudo cp server /usr/local/bin/kladde
sudo systemctl start kladde
```

## Conventions
- No hardcoded locale — use `navigator.language`
- Warm stone palette, no blue, no borders — use subtle backgrounds
- No hover effects on touch devices (`@media (hover: hover)`)
- Autosave only, no save button
- Mobile: full-screen list ↔ full-screen editor with slide transitions
