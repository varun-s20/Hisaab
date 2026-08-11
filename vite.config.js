import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Serves `api/categorise.js` during `npm run dev`, so the AI tier can actually
 * be exercised locally instead of only ever failing soft.
 *
 * The point of this plugin is that GEMINI_API_KEY stays in Node. Vite only
 * inlines variables prefixed `VITE_` into the browser bundle, so a plain
 * `GEMINI_API_KEY=...` in .env.local is read here and never shipped to a
 * client. Never rename it to VITE_GEMINI_API_KEY — that publishes your key.
 */
function devApi(env) {
  return {
    name: 'paisa-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/categorise', async (req, res) => {
        // Match production: falling through to the SPA fallback here would make
        // a GET return index.html locally and 405 on Vercel.
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        try {
          const chunks = []
          for await (const c of req) chunks.push(c)
          req.body = JSON.parse(Buffer.concat(chunks).toString() || '{}')

          // Vercel's handler signature, on top of a plain Node response.
          res.status = (code) => {
            res.statusCode = code
            return res
          }
          res.json = (body) => {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(body))
            return res
          }

          if (env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = env.GEMINI_API_KEY
          if (env.GEMINI_MODEL) process.env.GEMINI_MODEL = env.GEMINI_MODEL

          const { default: handler } = await import('./api/categorise.js')
          await handler(req, res)
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e) }))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // '' prefix loads every variable, not just VITE_ ones. This object stays in
  // the Node process — nothing here is passed to `define`.
  const env = loadEnv(mode, process.cwd(), '')

  return {
  plugins: [
    devApi(env),
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
  }
})
