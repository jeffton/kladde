# TODO

## Dependency maintenance

### Larger migrations
- evaluate Tiptap 3 migration (`@tiptap/*` latest is `3.20.1`)
- evaluate upgrading `tiptap-markdown` to `0.9.0` (it now peers on `@tiptap/core@^3.0.1`)

### Tooling / security follow-up
- investigate dev-only audit findings in the `vite-plugin-pwa` / `workbox-build` dependency chain
- revisit `golang.org/x/crypto` and `golang.org/x/sys` after upgrading the Go toolchain beyond `go1.22.2`
