// Loopback login server: the `webServer` seat dsh's deepseek-account-platform
// registers its `/oauth/callback` route on. dsh-host-webserver is a Web
// composition (gzip, index injection, TLS, fallback dist); the phone needs
// only one exact route on 127.0.0.1 with an OS-assigned port, opened when the
// first sign-in starts.
//
// The browser that reaches the callback is a Chrome Custom Tab on top of the
// app's own task. dsh answers the callback with a redirect to Platform's
// completion page (success), a small HTML failure page, or 204 (cancelled).
// On Android the tab must hand control back to the app, so those three
// answers are replaced with a local page that opens the app's deep link
// (automatically when Chrome allows it, and from a button otherwise). Every
// other answer (400 bad state, 410 stale attempt) passes through unchanged.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const CALLBACK_PATH = '/oauth/callback'
const COMPLETE_PATH = '/oauth/complete'

const COPY = {
  zh: {
    ok: ['登录成功', '正在返回 DSH…'],
    failed: ['登录失败', '请返回 DSH 重试。'],
    cancelled: ['登录已取消', '请返回 DSH 继续。'],
    back: '返回 DSH',
  },
  en: {
    ok: ['Signed in', 'Returning to DSH…'],
    failed: ['Could not sign in', 'Go back to DSH and try again.'],
    cancelled: ['Sign in cancelled', 'Go back to DSH to continue.'],
    back: 'Back to DSH',
  },
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * The app link the completion page opens. With a package name Chrome resolves
 * an `intent:` URL straight to the app; without one (host tests) a plain
 * custom-scheme URL is used.
 */
export function appLink(scheme, appPackage, result) {
  const path = `account/login?result=${encodeURIComponent(result)}`
  return appPackage
    ? `intent://${path}#Intent;scheme=${scheme};package=${appPackage};end`
    : `${scheme}://${path}`
}

/** The local completion page: dsh-styled card, one button, an automatic attempt. */
export function completionPage({ result, locale, link }) {
  const t = COPY[String(locale).toLowerCase().startsWith('zh') ? 'zh' : 'en']
  const [title, body] = t[result] ?? t.failed
  const nonce = randomBytes(16).toString('base64url')
  const html = `<!doctype html><html lang="${t === COPY.zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style nonce="${nonce}">
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px/22px system-ui,-apple-system,sans-serif;background:#fff;color:#0f1115}
@media (prefers-color-scheme:dark){body{background:#151517;color:#f3f4f6}.card{background:#1f1f22!important;border-color:#2c2c30!important}p{color:#a1a4ab!important}}
.card{box-sizing:border-box;width:min(360px,calc(100vw - 48px));padding:24px;border:0.5px solid #e5e6ea;border-radius:16px;background:#fafafa;text-align:center}
h1{margin:0 0 6px;font-size:18px;line-height:26px;font-weight:600}
p{margin:0 0 20px;color:#6b6f78}
a{display:block;height:40px;line-height:40px;border-radius:999px;background:#0f1115;color:#fff;text-decoration:none;font-weight:500}
@media (prefers-color-scheme:dark){a{background:#f3f4f6;color:#0f1115}}
</style></head><body><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>
<a id="back" href="${escapeHtml(link)}">${escapeHtml(t.back)}</a></main>
<script nonce="${nonce}">setTimeout(function(){location.href=document.getElementById('back').href},150)</script></body></html>`
  return {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
    },
    html,
  }
}

/** Map dsh's callback answer onto the Android completion result, or undefined to pass it through. */
export function callbackResult(status, headers) {
  if (status === 302 && typeof headers?.location === 'string') return 'ok'
  if (status === 200) return 'failed'
  if (status === 204) return 'cancelled'
  return undefined
}

/**
 * Wrap one callback response so dsh's success / failure / cancel answers are
 * rendered as the local completion page. dsh calls `writeHead(...).end(...)`.
 */
function adoptCallbackResponse(res, render) {
  const writeHead = res.writeHead.bind(res)
  const end = res.end.bind(res)
  let page
  res.writeHead = (status, ...rest) => {
    const headers = rest.find(v => v !== null && typeof v === 'object' && !Array.isArray(v))
    const result = callbackResult(status, headers)
    if (result === undefined) return writeHead(status, ...rest)
    page = render(result)
    writeHead(200, page.headers)
    return res
  }
  res.end = (...args) => page === undefined ? end(...args) : end(page.html)
  return res
}

/**
 * Create the loopback server. `register` accepts dsh webServer routes
 * (`{ kind: 'exact' | 'prefix', path, handler }`) and returns their disposer;
 * `listen()` binds 127.0.0.1 on an OS-assigned port once and resolves the origin.
 */
export function createLoopbackServer({ locale, scheme, appPackage, onComplete, log }) {
  const exact = new Map()
  const prefixes = new Map()
  let server
  let listening

  const render = result => {
    onComplete?.(result)
    return completionPage({ result, locale: locale(), link: appLink(scheme, appPackage, result) })
  }

  const route = pathname => exact.get(pathname)
    ?? [...prefixes.entries()].filter(([p]) => pathname === p || pathname.startsWith(`${p}/`))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1]

  const handle = async (req, res) => {
    let pathname
    try { pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname } catch { res.writeHead(400).end(); return }
    if (pathname === COMPLETE_PATH && req.method === 'GET') {
      const result = new URL(req.url, 'http://127.0.0.1').searchParams.get('result') ?? 'ok'
      const page = completionPage({ result, locale: locale(), link: appLink(scheme, appPackage, result) })
      res.writeHead(200, page.headers).end(page.html)
      return
    }
    const r = route(pathname)
    if (r === undefined) { res.writeHead(404, { 'cache-control': 'no-store' }).end(); return }
    await r.handler(req, pathname === CALLBACK_PATH ? adoptCallbackResponse(res, render) : res)
  }

  return {
    register(r) {
      const table = r.kind === 'exact' ? exact : prefixes
      if (table.has(r.path)) throw new Error(`loopback: duplicate ${r.kind} route "${r.path}"`)
      table.set(r.path, r)
      return () => { if (table.get(r.path) === r) table.delete(r.path) }
    },
    get port() { return server?.address()?.port },
    get origin() {
      const port = server?.address()?.port
      if (port === undefined) throw new Error('loopback: origin read before the listener bound a port')
      return `http://127.0.0.1:${port}`
    },
    listen() {
      listening ??= new Promise((resolve, reject) => {
        server = createServer((req, res) => {
          handle(req, res).catch(error => {
            log?.(`callback handler failed: ${error?.message ?? error}`)
            if (res.headersSent) res.destroy()
            else res.writeHead(500).end()
          })
        })
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          server.unref()
          resolve(`http://127.0.0.1:${server.address().port}`)
        })
      }).catch(error => { listening = undefined; throw error })
      return listening
    },
    async close() {
      if (server === undefined) return
      const s = server
      server = undefined
      listening = undefined
      await new Promise(resolve => { s.close(() => resolve()); s.closeAllConnections?.() })
    },
  }
}
