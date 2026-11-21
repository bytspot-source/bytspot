import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const supportFile = path.join(rootDir, 'public', 'support.html')

/**
 * /support and /support/ both serve public/support.html.
 * Render already does this for .html files. Vite does not, so dev and preview
 * need the same paths explicitly. Existing files such as robots.txt still win.
 */
function crawlSurfacePlugin(): Plugin {
  const pathnameOf = (url: string | undefined) => decodeURIComponent((url || '/').split('?')[0] || '/')

  const isSupportPath = (url: string | undefined) => {
    const pathname = pathnameOf(url)
    return pathname === '/support' || pathname === '/support/'
  }

  const missingCrawlFile = (url: string | undefined) => {
    const pathname = pathnameOf(url)
    const last = pathname.split('/').pop() || ''
    if (!/\.(txt|xml)$/i.test(last)) return false
    const rel = pathname.replace(/^\//, '')
    return ![path.join(rootDir, 'dist', rel), path.join(rootDir, 'public', rel)].some((file) => existsSync(file))
  }

  return {
    name: 'bytspot:crawl-surface',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (isSupportPath(req.url)) {
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(readFileSync(supportFile, 'utf8'))
          return
        }
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (isSupportPath(req.url)) {
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(readFileSync(supportFile, 'utf8'))
          return
        }
        // Match Render: a missing text or XML file is 404, not the homepage.
        if (missingCrawlFile(req.url)) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end('Not found')
          return
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), crawlSurfacePlugin()],
  server: {
    port: 3000,
    open: false,
    host: '127.0.0.1',
  },
  preview: {
    port: 4173,
    host: '127.0.0.1',
    open: false,
  },
})
