// @dsh-android/plugin-device — the dsh side of the capability channel
// (docs/ENGINE-CONTRACT.md §3/§4).
//
// - Opens the socketpair end named by DSH_BRIDGE_FD as a net.Socket.
// - capability/list → registers every ToolDescriptor as a dsh tool (raw JSON
//   Schema parameters), replacing the set on capability/changed.
// - risk "read" runs directly; "write" / "sensitive" / "dangerous" return an
//   `ask` decision from the `tools/pre-execute` waterfall, which dsh routes
//   through ctx.approval → the SDK `approval/request` server request.
// - capability/invoke results map to dsh tool content; images are stored in
//   the attachment store and returned as dsh image blocks.
// - budget/update notifications are re-published through the `androidBridge`
//   service for @dsh-android/plugin-guard.
// Without DSH_BRIDGE_FD the plugin logs once and registers nothing.
import { EventEmitter } from 'node:events'
import { BridgePeer } from './bridge.js'

export const name = 'android-device'
export const inject = ['tools']

const RISKS = new Set(['read', 'write', 'sensitive', 'dangerous'])
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const LIST_TIMEOUT_MS = 30_000
// Timeouts (docs/ENGINE-CONTRACT.md §3.1): the app's ToolDescriptor.timeoutMs is the single source of
// truth. The app answers (or gives up waiting for the user) a few seconds before it; the plugin's own
// limits sit slightly after it so the app's clearer result normally wins. On a timeout or an aborted
// turn the plugin sends `capability/cancel` so the app cancels the call instead of acting later.
export const DEFAULT_TIMEOUT_MS = 300_000
export const UNLOCK_TIMEOUT_MS = 900_000
const BRIDGE_GRACE_MS = 10_000
const TOOL_GRACE_MS = 15_000

// Policy footer of every device tool description. Kept short: it is repeated in each loaded
// definition; plugin-guard's phone section explains it once.
const RISK_NOTE = {
  read: 'read-only',
  write: 'changes the phone',
  sensitive: 'private data',
  dangerous: 'destructive; always asks',
}

// SDK mode reserves stdout for JSON-RPC; plugin diagnostics go to stderr (the app logs it).
function log(_ctx, level, message) {
  process.stderr.write(`[android-device] ${level === 'info' ? '' : level + ': '}${message}\n`)
}

/** Validate one untrusted ToolDescriptor; returns a normalized copy or a reason string. */
export function normalizeDescriptor(raw) {
  if (raw === null || typeof raw !== 'object') return 'descriptor is not an object'
  const { name: toolName, group, description, inputSchema, risk, needsUnlock, timeoutMs } = raw
  if (typeof toolName !== 'string' || !TOOL_NAME.test(toolName)) return `invalid tool name ${JSON.stringify(toolName)}`
  if (!RISKS.has(risk)) return `tool ${toolName}: invalid risk ${JSON.stringify(risk)}`
  if (typeof description !== 'string' || description.trim() === '') return `tool ${toolName}: missing description`
  let schema = inputSchema
  if (schema === undefined || schema === null) schema = { type: 'object', properties: {} }
  if (typeof schema !== 'object' || Array.isArray(schema)) return `tool ${toolName}: inputSchema must be a JSON Schema object`
  if (schema.type === undefined) schema = { type: 'object', ...schema }
  if (schema.type !== 'object') return `tool ${toolName}: inputSchema must describe an object`
  return {
    name: toolName,
    group: typeof group === 'string' ? group : 'system',
    description: description.trim(),
    inputSchema: structuredClone(schema),
    risk,
    needsUnlock: needsUnlock === true,
    timeoutMs: typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.round(timeoutMs)
      : needsUnlock === true ? UNLOCK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  }
}

/** Model-facing description: the app's text plus a one-line policy footer. */
export function toolDescription(d) {
  const parts = [`risk: ${d.risk} (${RISK_NOTE[d.risk]})`]
  if (d.needsUnlock) parts.push('needs the phone unlocked')
  return `${d.description}\n[${parts.join('; ')}]`
}

/** The session id the app knows: the root of a subagent chain. */
function appSessionId(ctx, agent) {
  if (agent === undefined) return undefined
  let session = agent.session
  const seen = new Set()
  while (session?.header?.parentSession !== undefined && !seen.has(String(session.id))) {
    seen.add(String(session.id))
    const parentId = String(session.header.parentSession)
    const parent = ctx.get('agents')?.list?.().find(a => String(a.session.id) === parentId)
    if (parent === undefined) return parentId
    session = parent.session
  }
  return String(session.id)
}

async function routeAcceptsImages(ctx, exec) {
  try {
    const routed = exec.agent?.session.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    const llm = ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) return false
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

/** Convert ToolResult.content into JSON-serializable dsh content (images stored as attachments). */
async function toDshContent(ctx, exec, content) {
  const out = []
  let imageCapable
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text })
    } else if (block?.type === 'image' && typeof block.data === 'string') {
      const mediaType = String(block.mimeType ?? '').toLowerCase()
      const bytes = Buffer.from(block.data, 'base64')
      imageCapable ??= await routeAcceptsImages(ctx, exec)
      const attachments = ctx.get('attachments')
      if (!IMAGE_TYPES.has(mediaType)) {
        out.push({ type: 'text', text: `[image omitted: unsupported type ${mediaType || 'unknown'}]` })
      } else if (!imageCapable) {
        out.push({ type: 'text', text: `[${mediaType} image (${bytes.length} bytes) omitted: the current model does not accept image input; use a text-returning tool such as the screen element tree instead]` })
      } else if (attachments === undefined) {
        out.push({ type: 'text', text: '[image omitted: no attachment store is mounted]' })
      } else {
        try {
          const ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType, name: `${exec.name}.${mediaType.split('/')[1]}` })
          out.push({ type: 'image', attachment: JSON.parse(JSON.stringify(ref)) })
        } catch (error) {
          out.push({ type: 'text', text: `[image omitted: it could not be stored (${error?.message ?? error})]` })
        }
      }
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '(no output)' })
  return out
}

export function apply(ctx, config = {}) {
  const rawFd = config.fd ?? process.env.DSH_BRIDGE_FD
  if (rawFd === undefined || rawFd === '') {
    log(ctx, 'info', 'DSH_BRIDGE_FD is not set; no device tools will be registered')
    return
  }
  const fd = Number(rawFd)
  if (!Number.isSafeInteger(fd) || fd < 0) {
    log(ctx, 'warn', `DSH_BRIDGE_FD=${JSON.stringify(rawFd)} is not a file descriptor; no device tools will be registered`)
    return
  }
  let peer
  try {
    peer = BridgePeer.fromFd(fd)
  } catch (error) {
    log(ctx, 'warn', `cannot open capability bridge fd ${fd}: ${error?.message ?? error}; no device tools will be registered`)
    return
  }
  // The SDK stdin owns process lifetime; the bridge must not keep Node alive.
  peer.unref()

  /** name → { descriptor, key, dispose } */
  const registered = new Map()
  const events = new EventEmitter()
  let budget = {}
  let disposed = false

  const service = {
    get connected() { return !peer.closed },
    get budget() { return { ...budget } },
    /** Subscribe to budget updates; returns an unsubscribe function. */
    onBudget(listener) { events.on('budget', listener); return () => events.off('budget', listener) },
    descriptorOf(toolName) { return registered.get(toolName)?.descriptor },
    tools() { return [...registered.values()].map(r => r.descriptor) },
    request(method, params, options) { return peer.request(method, params, options) },
    notify(method, params) { peer.notify(method, params) },
  }
  ctx.provide('androidBridge', service)

  const definitionFor = d => ({
    name: d.name,
    description: toolDescription(d),
    parameters: d.inputSchema,
    timeoutMs: d.timeoutMs + TOOL_GRACE_MS,
    isConcurrencySafe: () => d.risk === 'read',
    output: {
      schema: {},
      render: (_args, value) => Array.isArray(value?.content) ? value.content : [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const sessionId = appSessionId(ctx, exec.agent) ?? ''
      const callId = String(exec.callId)
      let result
      try {
        result = await peer.request('capability/invoke', {
          sessionId,
          callId,
          tool: d.name,
          args: args ?? {},
          timeoutMs: d.timeoutMs,
        }, { signal: exec.signal, timeoutMs: d.timeoutMs + BRIDGE_GRACE_MS })
      } catch (error) {
        // Timed out or aborted (turn stopped, tool deadline): the app must not act on it later.
        if (error?.code === 'BRIDGE_TIMEOUT' || exec.signal?.aborted) {
          peer.notify('capability/cancel', { sessionId, callId, reason: error?.code === 'BRIDGE_TIMEOUT' ? 'timeout' : 'aborted' })
        }
        throw error
      }
      if (result === null || typeof result !== 'object') throw new Error(`${d.name}: the app returned an invalid ToolResult`)
      if (result.ok !== true) {
        const code = result.error?.code ?? 'failed'
        const message = result.error?.message ?? 'the device capability failed'
        const detail = (Array.isArray(result.content) ? result.content : [])
          .filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
        throw Object.assign(new Error(`[${code}] ${message}${detail ? `\n${detail}` : ''}`), { code })
      }
      return { content: await toDshContent(ctx, exec, result.content) }
    },
  })

  const unregisterAll = () => {
    for (const entry of registered.values()) {
      try { entry.dispose() } catch {}
    }
    registered.clear()
  }

  const applyList = descriptors => {
    const next = new Map()
    for (const raw of Array.isArray(descriptors) ? descriptors : []) {
      const d = normalizeDescriptor(raw)
      if (typeof d === 'string') { log(ctx, 'warn', `skipping capability: ${d}`); continue }
      if (next.has(d.name)) { log(ctx, 'warn', `skipping duplicate capability ${d.name}`); continue }
      next.set(d.name, d)
    }
    // Remove changed or vanished tools first so re-registration cannot collide.
    for (const [toolName, entry] of [...registered]) {
      const d = next.get(toolName)
      if (d === undefined || JSON.stringify(d) !== entry.key) {
        try { entry.dispose() } catch {}
        registered.delete(toolName)
      }
    }
    let added = 0
    for (const [toolName, d] of next) {
      if (registered.has(toolName)) continue
      if (ctx.tools.get?.(toolName) !== undefined) {
        log(ctx, 'warn', `capability ${toolName} collides with an existing dsh tool; skipped`)
        continue
      }
      try {
        const dispose = ctx.tools.register(definitionFor(d))
        registered.set(toolName, { descriptor: d, key: JSON.stringify(d), dispose })
        added += 1
      } catch (error) {
        log(ctx, 'warn', `cannot register capability ${toolName}: ${error?.message ?? error}`)
      }
    }
    log(ctx, 'info', `device tools: ${registered.size} registered (${added} new)`)
  }

  // Serialized, coalesced re-listing.
  let refreshing
  let again = false
  const refresh = () => {
    if (refreshing !== undefined) { again = true; return refreshing }
    refreshing = (async () => {
      let attempt = 0
      do {
        again = false
        try {
          const result = await peer.request('capability/list', {}, { timeoutMs: LIST_TIMEOUT_MS })
          if (disposed) return
          applyList(result?.tools)
          attempt = 0
        } catch (error) {
          if (disposed || peer.closed) return
          attempt += 1
          log(ctx, 'warn', `capability/list failed (${error?.message ?? error})${attempt < 4 ? '; retrying' : ''}`)
          if (attempt < 4) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt).unref?.()); again = true }
        }
      } while (again && !disposed)
    })().finally(() => { refreshing = undefined })
    return refreshing
  }

  peer.on('notification', (method, params) => {
    if (method === 'capability/changed') void refresh()
    else if (method === 'budget/update') {
      const next = {}
      for (const key of ['sessionTokenLimit', 'dailyTokenLimit', 'dailyCostLimitCny']) {
        const value = params?.[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) next[key] = value
      }
      budget = next
      events.emit('budget', { ...budget })
    }
  })
  peer.on('protocol-error', error => log(ctx, 'warn', error.message))
  peer.on('close', error => {
    if (disposed) return
    log(ctx, 'warn', `capability bridge closed${error ? `: ${error.message}` : ''}; device tools removed`)
    unregisterAll()
  })

  // Risk → approval. Runs after earlier policy listeners (plugin-guard prepends
  // its hardline floor); only an `allow` from the rest of the chain is upgraded
  // to `ask`, so a deny elsewhere always wins.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const entry = registered.get(exec.name)
    const decision = await next()
    if (entry === undefined || entry.descriptor.risk === 'read' || decision?.kind !== 'allow') return decision
    const d = entry.descriptor
    let argsText = ''
    try { argsText = JSON.stringify(exec.arguments ?? {}) } catch {}
    if (argsText.length > 2000) argsText = argsText.slice(0, 2000) + '…'
    return {
      kind: 'ask',
      reason: `Android ${d.group} tool "${d.name}" (risk: ${d.risk}${d.needsUnlock ? ', needs unlock' : ''}) wants to run with ${argsText}`,
    }
  })

  ctx.effect(() => {
    void refresh()
    return () => {
      disposed = true
      unregisterAll()
      peer.close()
    }
  }, 'android-device.bridge')
}
