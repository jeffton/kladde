# AGENTS.md — kladde

## Screenshots
When taking screenshots (Playwright, QA, etc.), save them in `screenshots/` (gitignored).
Do NOT save screenshots in the project root or other directories.

## Build & Deploy
Every production deployment must deploy both the client and server. Use the deployment script; do not deploy either component separately.

```bash
./scripts/deploy.sh
```

The script builds both components before changing production, synchronizes the client bundle to `/var/lib/kladde/dist/`, installs the server at `/usr/local/bin/kladde`, restarts `kladde`, and verifies its health endpoint.

## Conventions
- No hardcoded locale — use `navigator.language`
- Warm stone palette, no blue, no borders — use subtle backgrounds
- No hover effects on touch devices (`@media (hover: hover)`)
- Autosave only, no save button
- Mobile: full-screen list ↔ full-screen editor with slide transitions
