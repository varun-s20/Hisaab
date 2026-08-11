import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Paisa',
        short_name: 'Paisa',
        description: 'UPI screenshots in, real ledger out.',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0E1012',
        theme_color: '#0E1012',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Tesseract's WASM + language data are large; cache them or every cold
        // start re-downloads ~10MB and the app feels broken.
        globPatterns: ['**/*.{js,css,html,png,svg,wasm,traineddata,gz}'],
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'tesseract-assets', expiration: { maxEntries: 20 } },
          },
          {
            urlPattern: /^https:\/\/unpkg\.com\/.*/i,
            handler: 'CacheFirst',
            options: { cacheName: 'tesseract-assets', expiration: { maxEntries: 20 } },
          },
        ],
      },
    }),
  ],
})
