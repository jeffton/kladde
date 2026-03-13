# TODO

## Dependency maintenance

### Safe/contained frontend updates
- update `vue` to `3.5.30`
- update `lucide-vue-next` to `0.577.0`
- update `tiptap-markdown` to `0.9.0`
- normalize all `@tiptap/*` version ranges in `client/package.json` to consistent 2.x versions (the manifest is stale compared to the installed tree)

### Larger migrations
- evaluate Tiptap 3 migration (`@tiptap/*` latest is `3.20.1`)
- evaluate Vue Router 5 migration (`vue-router` latest is `5.0.3`)

### Tooling / security follow-up
- investigate dev-only audit findings in the `vite-plugin-pwa` / `workbox-build` dependency chain
- revisit `golang.org/x/crypto` and `golang.org/x/sys` after upgrading the Go toolchain beyond `go1.22.2`
