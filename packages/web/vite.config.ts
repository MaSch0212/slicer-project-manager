import tailwindcss from '@tailwindcss/vite'
import solid from 'vite-plugin-solid'
import { defineConfig } from 'vitest/config'

// Every listener binds 127.0.0.1: binding all interfaces raises a firewall prompt on Windows, and
// the dev server has no business being reachable from the LAN.
const HOST = '127.0.0.1'
// Overridable so the Playwright run can use its own port beside a developer's `pnpm dev:web`.
const PORT = Number(process.env['SPM_VITE_PORT'] ?? 5173)

export default defineConfig(({ mode }) => ({
  plugins: [solid({ hot: mode !== 'test' }), tailwindcss()],
  server: {
    host: HOST,
    port: PORT,
    strictPort: true,
    // spm-server proxies the page to here (SPM_DEV_UI_ORIGIN) but not the HMR socket, so the
    // browser talks to Vite directly for hot reload.
    hmr: { host: HOST, clientPort: PORT },
  },
  preview: { host: HOST, port: PORT, strictPort: true },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
  },
}))
