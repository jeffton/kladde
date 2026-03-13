import { defineConfig } from "vite-plus";
import vue from "@vitejs/plugin-vue";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "kladde",
        short_name: "kladde",
        description: "Offline-first markdown note app",
        theme_color: "#f0ece4",
        background_color: "#f0ece4",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/pwa-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^\/client-api\/.*$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "api-cache",
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24,
              },
            },
          },
        ],
      },
    }),
  ],
  fmt: {
    ignorePatterns: ["dist/**"],
  },
  lint: {
    ignorePatterns: ["dist/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "prosemirror",
              test: /node_modules[\\/]prosemirror/,
              priority: 30,
            },
            {
              name: "tiptap",
              test: /node_modules[\\/]@tiptap/,
              priority: 25,
            },
            {
              name: "markdown",
              test: /node_modules[\\/](?:tiptap-markdown|markdown-it|mdast|micromark|remark|rehype)/,
              priority: 20,
            },
            {
              name: "vendor",
              test: /node_modules/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  server: {
    proxy: {
      "/client-api": "http://localhost:8080",
      "/api": "http://localhost:8080",
    },
  },
});
