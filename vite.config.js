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
const ROUTES = ['categorise', 'ask']

function devApi(env) {
  return {
    name: 'hisaab-dev-api',
    apply: 'serve',
    configureServer(server) {
      for (const route of ROUTES) devRoute(server, env, route)
    },
  }
}

function devRoute(server, env, route) {
  server.middlewares.use(`/api/${route}`, async (req, res) => {
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
      // api/_auth.js verifies the caller's Supabase token against the project.
      // Both of these are public values the browser bundle already carries —
      // they are here so the dev shim can do the same check production does,
      // instead of being the one place with no auth at all.
      for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
        if (env[k]) process.env[k] = env[k]
      }

      const { default: handler } = await import(`./api/${route}.js`)
      await handler(req, res)
    } catch (e) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(e) }))
    }
  })
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
      includeAssets: [
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-512.png',
        'apple-touch-icon.png',
      ],
      manifest: {
        name: 'Hisaab',
        short_name: 'Hisaab',
        description: 'UPI screenshots in, real ledger out.',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        // Android's share sheet. Screenshot → Share → Hisaab, without opening
        // the app first. Handled in public/share-target.js inside the service
        // worker, so it only works on the installed PWA over HTTPS.
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            files: [{ name: 'images', accept: ['image/*'] }],
          },
        },
        // The splash is the icon on background_color, so this is the logo's own
        // field — the icon melts into the splash instead of sitting on a cream
        // card. theme_color is the page, because that is what the status bar
        // sits above once the app is actually open. Two different jobs.
        // Printed by `npm run icons` — keep the two in step if the logo changes.
        background_color: '#A8E46C',
        theme_color: '#F1F1ED',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          // A separate file, not the same one relabelled: a launcher may crop
          // ~20% off every edge of a maskable icon, which would cut through
          // "BY BROOMBUILDS". This one has the lockup inset to 70%.
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Tesseract's WASM and language data are ~12MB and are self-hosted (see
        // src/lib/ocr.js). Deliberately NOT precached: precaching them would put
        // a 12MB download in front of the first launch for a feature the user
        // may not reach that session. They get a CacheFirst runtime rule below
        // instead, so the cost is paid once, on the first OCR.
        globPatterns: ['**/*.{js,css,html,png,svg}'],
        // Same argument as tesseract, smaller numbers: the setup screenshots are
        // ~280KB and are only ever seen by someone connecting a Supabase project
        // of their own, which most people never do. Precaching them would put
        // that download in front of every first launch. Runtime rule below.
        globIgnores: ['**/tesseract/**', '**/setup/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // The share-target POST must reach our own fetch handler, not the SPA
        // navigation fallback, which would swallow it and lose the files.
        navigateFallbackDenylist: [/^\/api\//, /^\/share-target/],
        importScripts: ['/share-target.js', '/reminders.js'],
        runtimeCaching: [
          {
            // Our own copies. Nothing is fetched from jsdelivr or unpkg any
            // more, so the two rules that used to cache those origins are gone
            // — a CacheFirst rule over a whole third-party CDN is a standing
            // offer to pin one bad response forever.
            urlPattern: ({ url }) => url.pathname.startsWith('/tesseract/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'tesseract-assets',
              expiration: { maxEntries: 10 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Fetched the first time somebody opens the BYO setup, kept after
            // that — so stepping back and forth through it, or coming back to
            // finish tomorrow, costs nothing and works on a bad connection.
            urlPattern: ({ url }) => url.pathname.startsWith('/setup/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'setup-screenshots',
              expiration: { maxEntries: 10 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Inter comes off Google's CDN. Without this the app falls back to
            // the system face the moment it's offline, which is the whole point
            // of a PWA failing.
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  }
})
