import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const appBase = '/FB-Messages-Archive-Explorer/'

// https://vite.dev/config/
export default defineConfig({
  base: appBase,
  plugins: [
    react(),
    VitePWA({
      strategies: 'generateSW',
      registerType: 'prompt',
      scope: appBase,
      workbox: {
        cacheId: 'fb-messages-archive-explorer',
        // Manifest icons and manifest.webmanifest are added by the plugin separately.
        // Keeping PNGs out also avoids caching the README-only demo screenshot.
        globPatterns: ['**/*.{js,css,html,ico,svg}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      manifest: {
        id: appBase,
        name: 'FB Messages Archive Explorer',
        short_name: 'FB Archive',
        description: 'Browse your Facebook Messenger archive locally and privately.',
        theme_color: '#0b1116',
        background_color: '#0b1116',
        display: 'standalone',
        start_url: appBase,
        scope: appBase,
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
