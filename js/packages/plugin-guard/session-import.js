// 会话迁移导入（设置 → 导入数据（文件夹）选「按会话分目录」的全量导出）。
//
// 旧实例导出的 `events.jsonl` 只保留了事件 data（信封字段丢了）并且缺一部分事件，
// 当前 harness 的会话日志是 fail-closed 严格校验的，所以这里先做结构修复：
//   1. seq 从 0 起连续重编号，并重写已知的 seq 引用（throughSeq / shadowedSeqs / messageSeqs / shadowedRange）；
//   2. 补齐 turn/step 的开闭结构，缺 turn/end、step/end 的补合成事件；
//   3. 给 surface 类事件补信封 surfaceOp:'append'，给插件命名空间事件补 ignorable:true，消息补字符串 id；
//   4. 丢孤儿 tool/result，给没收到结果的 tool/call 补中断结果；
//   5. 丢弃依赖未导出元数据的事件（request/*、llm/retry*、compaction/*）。
// 写出的日志按「首帧 = header 一行」的 zstd 分帧格式落盘；默认只写 DB 数据（可读），
// 需要让引擎能续聊时传 writeLog:true（风险：个别旧事件仍可能过不了更严的校验）。
//
// `android/session/import { dir?, writeLog? }`：转换 dir（默认 $DSH_HOME/android/import-sessions）里的会话，
// 返回每个会话的元数据 + 事件行（由 App 写进自己的会话库），并把结果写到 import-result.json。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

export const METHOD = 'android/session/import'
export const RESULT_FILE = 'import-result.json'

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])
// 依赖 request/header 或与 surface 强绑定的元事件：旧导出里缺失/不完整，整体丢弃比伪造安全。
const SKIP_TYPES = new Set([
  'request/header', 'request/context', 'llm/retry', 'llm/retry-started',
  'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune',
])

const SEQ_FIELDS = new Set(['throughSeq'])
const SEQ_ARRAY_FIELDS = new Set(['shadowedSeqs', 'messageSeqs'])

function remap(data, map, curSeq, dropped) {
  const walk = (value, key) => {
    if (Array.isArray(value)) {
      if (SEQ_ARRAY_FIELDS.has(key)) {
        const kept = []
        for (const item of value) {
          if (typeof item !== 'number') { kept.push(item); continue }
          if (map.has(item)) kept.push(map.get(item)); else dropped.push(`${key}:${item}`)
        }
        return kept
      }
      return value.map(item => walk(item, key))
    }
    if (value && typeof value === 'object') {
      if (key === 'shadowedRange' && typeof value.start === 'number' && typeof value.end === 'number') {
        if (!map.has(value.start) || !map.has(value.end)) { dropped.push('shadowedRange'); return undefined }
        return { ...value, start: map.get(value.start), end: map.get(value.end) }
      }
      const out = {}
      for (const [k, v] of Object.entries(value)) {
        if (SEQ_FIELDS.has(k) && typeof v === 'number') {
          if (map.has(v)) out[k] = map.get(v)
          else { out[k] = Math.max(0, curSeq - 1); dropped.push(`${k}:${v}`) }
          continue
        }
        const mapped = walk(v, k)
        if (mapped !== undefined) out[k] = mapped
      }
      return out
    }
    return value
  }
  const result = walk(data, '')
  return result === undefined ? {} : result
}

function withIds(data) {
  if (data?.message && typeof data.message === 'object' && typeof data.message.id !== 'string') data.message.id = crypto.randomUUID()
  if (typeof data?.id !== 'string' && (data?.role === 'user' || data?.role === 'assistant')) data.id = crypto.randomUUID()
  return data
}

/** 把一份 events.jsonl 修成「结构自洽、seq 连续」的事件序列。 */
export function repairEvents(rawEvents, { cwd, id, createdAt }) {
  const positive = rawEvents.filter(e => typeof e?.seq === 'number' && e.seq >= 0).sort((a, b) => a.seq - b.seq)
  const negative = rawEvents.filter(e => typeof e?.seq === 'number' && e.seq < 0)
  const out = []
  const map = new Map()
  let synthetic = 0
  let dropped = 0
  let turn = null
  let step = null
  const openCalls = new Set()

  const flushCalls = () => {
    for (const callId of [...openCalls]) {
      out.push({
        type: 'tool/result', time: step?.time ?? turn?.time ?? Date.now(), synthetic: true,
        data: {
          turn: step?.turn ?? turn?.n ?? 1, step: step?.n ?? 1,
          message: {
            id: crypto.randomUUID(), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
            content: [{ type: 'text', text: '（工具调用未完成：导入旧会话时补的中断结果）' }], isError: true,
          },
          isError: true,
        },
      })
      synthetic += 1
      openCalls.delete(callId)
    }
  }
  const closeStep = () => { flushCalls(); if (step) { out.push({ type: 'step/end', time: step.time, data: { turn: step.turn, step: step.n }, synthetic: true }); synthetic += 1; step = null } }
  const closeTurn = () => { closeStep(); if (turn) { out.push({ type: 'turn/end', time: turn.time, data: { turn: turn.n, reason: { kind: 'completed' } }, synthetic: true }); synthetic += 1; turn = null } }

  for (const event of positive) {
    const data = event.data ?? {}
    if (SKIP_TYPES.has(event.type)) { dropped += 1; continue }
    switch (event.type) {
      case 'turn/start': {
        if (turn) closeTurn()
        turn = { n: data.turn, time: event.time }
        step = null
        map.set(event.seq, out.length)
        out.push({ type: event.type, time: event.time, data })
        break
      }
      case 'step/start': {
        if (!turn) turn = { n: data.turn, time: event.time }
        if (step) closeStep()
        data.turn = turn.n
        step = { n: data.step, turn: turn.n, time: event.time }
        map.set(event.seq, out.length)
        out.push({ type: event.type, time: event.time, data })
        break
      }
      case 'step/end': {
        if (!step) { dropped += 1; break }
        data.turn = step.turn; data.step = step.n
        step = null
        map.set(event.seq, out.length)
        out.push({ type: event.type, time: event.time, data })
        break
      }
      case 'turn/end': {
        if (!turn) { dropped += 1; break }
        data.turn = turn.n
        closeStep()
        turn = null
        map.set(event.seq, out.length)
        out.push({ type: event.type, time: event.time, data })
        break
      }
      case 'tool/call': {
        if (!turn || !step) { dropped += 1; break }
        if (data.turn !== undefined) data.turn = turn.n
        if (data.step !== undefined) data.step = step.n
        if (data.callId) openCalls.add(data.callId)
        step.time = event.time; turn.time = event.time
        map.set(event.seq, out.length)
        out.push({ type: event.type, time: event.time, data })
        break
      }
      case 'tool/result': {
        const callId = data?.toolCallId ?? data?.message?.toolCallId
        if (!turn || !step) { if (callId) openCalls.delete(callId); dropped += 1; break }
        if (data.turn !== undefined) data.turn = turn.n
        if (data.step !== undefined) data.step = step.n
        withIds(data)
        if (callId) openCalls.delete(callId)
        step.time = event.time; turn.time = event.time
        map.set(event.seq, out.length)
        out.push({ type: event.type, time: event.time, data })
        break
      }
      default: {
        if (step) step.time = event.time
        if (turn) turn.time = event.time
        if (event.type === 'user/message' || event.type === 'assistant/message') withIds(data)
        map.set(event.seq, out.length)
        out.push({ type: event.type, time: event.time, data })
      }
    }
  }

  // 第二遍：按新顺序编号 + 重写 seq 引用 + 补齐信封字段
  const header = { type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 }
  const lines = [header]
  const rows = []
  const missing = []
  out.forEach((event, seq) => {
    const droppedRefs = []
    const data = remap(event.data ?? {}, map, seq, droppedRefs)
    if (droppedRefs.length) missing.push(...droppedRefs.map(r => `${event.type}#${seq} ${r}`))
    const row = { type: event.type, seq, time: event.time, data }
    if (SURFACE_TYPES.has(event.type)) row.surfaceOp = 'append'
    if (event.type.includes(':')) row.ignorable = true
    lines.push(row)
    rows.push({ seq, type: event.type, json: JSON.stringify(data), time: event.time })
  })
  for (const event of negative) rows.push({ seq: event.seq, type: event.type, json: JSON.stringify(event.data ?? {}), time: event.time })
  return { header, lines, rows, stats: { synthetic, dropped, missing: missing.length, events: rows.length } }
}

/** 首帧 = header 一行，其余事件一帧。 */
export function frameLog(lines) {
  const [headerLine, ...rest] = lines
  const first = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(headerLine)}\n`, 'utf8'))
  const body = rest.length ? zlib.zstdCompressSync(Buffer.from(`${rest.map(l => JSON.stringify(l)).join('\n')}\n`, 'utf8')) : Buffer.alloc(0)
  return Buffer.concat([first, body])
}

/** 从 repaired 行里抽「用户/助手」文本（工具调用、思考块不进记忆，只保对话）。 */
function chatText(rows) {
  const out = [];
  const pick = (c) => Array.isArray(c) ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('').trim() : ''
  const cut = (t, n) => (t || '').length > n ? t.slice(0, n) + '…' : (t || '')
  // 参数摘要：挑几个短字段，避免把整段 JSON 塞进来
  const argBrief = (a) => {
    if (!a || typeof a !== 'object') return ''
    const parts = []
    for (const [k, v] of Object.entries(a)) {
      if (v == null || typeof v === 'object') continue
      parts.push(k + '=' + cut(String(v), 120))
      if (parts.length >= 4) break
    }
    return parts.join(', ')
  }
  for (const r of rows) {
    if (typeof r.seq !== 'number' || r.seq < 0) continue
    let d
    try { d = JSON.parse(r.json) } catch { continue }
    if (r.type === 'user/message') {
      const t = pick(d.content)
      if (t) out.push({ role: 'user', text: t })
    } else if (r.type === 'assistant/message') {
      const t = pick(d.message?.content)
      if (t) out.push({ role: 'assistant', text: t })
    } else if (r.type === 'tool/call') {
      // 工具调用：压缩成一行文本，保留"做了什么"，让模型知道当时查过什么
      const name = d.name || d.tool || d.toolName || '?'
      const brief = argBrief(d.args || d.arguments || d.input)
      out.push({ role: 'assistant', text: '〔调用 ' + name + (brief ? ': ' + brief : '') + '〕' })
    } else if (r.type === 'tool/result') {
      // 工具结果：只留前 400 字，避免日志爆炸
      const content = pick(d.content) || (typeof d.result === 'string' ? d.result : '') || (typeof d.output === 'string' ? d.output : '')
      const t = cut(content, 400)
      if (t) out.push({ role: 'assistant', text: '〔结果〕' + t })
    }
  }
  return out
}

/**
 * 把历史对话重建为**当前 harness 一定能读的** v4 日志（只含 user/assistant 文本消息 + turn/step 结构）。
 * 旧实例的事件带插件信封、缺 turn/end、tool/result 残片，原样写进 sessions/ 会被 fail-closed 校验拒绝；
 * 重建后引擎能 resume，模型就能带着上下文继续（代价：工具调用与思考块不进记忆）。
 */
export function buildResumeLog(rows, { id, createdAt, cwd }) {
  const msgs = chatText(rows)
  const events = []
  let seq = 0
  let turn = 0
  let open = false
  const push = (type, data, extra = {}) => events.push({ type, seq: seq++, time: Date.now(), data, ...extra })
  const closeTurn = () => { if (!open) return; push('step/end', { turn, step: 1 }); push('turn/end', { turn, reason: { kind: 'completed' } }); open = false }
  for (const m of msgs) {
    if (m.role === 'user') {
      closeTurn()
      turn += 1
      push('turn/start', { turn })
      push('step/start', { turn, step: 1 })
      open = true
      push('user/message', { content: [{ type: 'text', text: m.text }], source: { kind: 'user', rpcId: crypto.randomUUID(), clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, role: 'user', id: crypto.randomUUID() }, { surfaceOp: 'append' })
    } else {
      if (!open) {
        turn += 1
        push('turn/start', { turn })
        push('step/start', { turn, step: 1 })
        open = true
      }
      push('assistant/message', { turn, step: 1, stream: [], message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: m.text }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat', replayState: { response: { kind: 'deepseek-messages', version: 1, model: 'deepseek-chat' }, blocks: [{ type: 'text' }] } } } }, { surfaceOp: 'append' })
    }
  }
  closeTurn()
  const header = { type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 }
  return [header, ...events]
}

/** 把内容 sha256 的对象放进附件对象库（只放被事件真正引用的）。 */
function storeAttachments(attachmentsDir, referenced, objectsDir) {
  let stored = 0
  if (!attachmentsDir || !fs.existsSync(attachmentsDir)) return stored
  for (const name of fs.readdirSync(attachmentsDir)) {
    const file = path.join(attachmentsDir, name)
    let stat
    try { stat = fs.statSync(file) } catch { continue }
    if (!stat.isFile()) continue
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    if (!referenced.has(hash)) continue
    const target = path.join(objectsDir, hash.slice(0, 2), hash.slice(2))
    if (fs.existsSync(target)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(file, target)
    stored += 1
  }
  return stored
}

/**
 * 转换一个导出目录里的所有会话。
 * @param options.dir 导出根目录（每个子目录一个会话）
 * @param options.home $DSH_HOME
 * @param options.cwd 引擎工作目录（写进 header，决定 sessions/<project> 位置）
 * @param options.writeLog 是否把修好的日志写进 sessions/（默认 false：只回传 DB 行，保证不出现打不开的会话）
 * @param options.dryRun 只体检不落盘
 */
export function importSessions({ dir, home, cwd, writeLog = false, dryRun = false, only = null }) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError(`${METHOD} requires a dir string`)
  if (!fs.existsSync(dir)) throw new Error(`${METHOD}: no such directory: ${dir}`)
  // 引擎的项目目录名 = `--` + cwd 去掉首尾斜杠、把每个 `/` 换成 `-` + `--`（点要保留！）
  const projectKey = '--' + cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') + '--'
  const sessionsDir = path.join(home, 'sessions', projectKey)
  const rowsDir = path.join(home, 'android', 'import-rows')
  const objectsDir = path.join(home, 'attachments', 'v1', 'objects')
  const results = []
  for (const name of only ? [only] : fs.readdirSync(dir)) {
    const sessionDir = path.join(dir, name)
    let stat
    try { stat = fs.statSync(sessionDir) } catch { continue }
    if (!stat.isDirectory()) continue
    const metaFile = path.join(sessionDir, 'session.json')
    const eventsFile = path.join(sessionDir, 'events.jsonl')
    if (!fs.existsSync(metaFile) || !fs.existsSync(eventsFile)) continue
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    const raw = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
    const id = meta.id
    const title = name // 按会话名导入
    const repaired = repairEvents(raw, { cwd, id, createdAt: meta.createdAt ?? Date.now() })
    const referenced = new Set()
    for (const line of repaired.lines) for (const match of JSON.stringify(line).matchAll(/"attachmentId":"sha256:([0-9a-f]{64})"/g)) referenced.add(match[1])
    let attachments = 0
    if (!dryRun) attachments = storeAttachments(path.join(sessionDir, 'attachments'), referenced, objectsDir)
    const session = {
      id, title, createdAt: meta.createdAt ?? Date.now(),
      pinned: meta.pinned ? 1 : 0, archived: meta.archived ? 1 : 0, muted: meta.muted ? 1 : 0,
      preset: meta.preset ?? 'danger-full-access', modeId: meta.modeId ?? null,
      modelProvider: meta.modelProvider ?? '', modelId: meta.modelId ?? '', modelEffort: meta.modelEffort ?? '',
    }
    let logPath = null
    // 事件行写成 JSONL：App 侧逐行读、分批入库，避免把几万条事件塞进一个 JSON（旧实现 OOM 闪退）
    let rowsFile = null
    if (!dryRun) {
      fs.mkdirSync(rowsDir, { recursive: true })
      rowsFile = path.join(rowsDir, id + '.jsonl')
      fs.writeFileSync(rowsFile, repaired.rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    }
    if (writeLog && !dryRun) {
      const target = path.join(sessionsDir, id)
      // 重复导入：先删掉旧的（可能不合法、会让 resume 失败 → create 撞 already exists）
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(target, { recursive: true })
      logPath = path.join(target, 'session.v4.jsonl.zstd')
      // 重建成引擎一定能 resume 的日志：模型才会带着旧上下文继续（否则只是"看得见"）
      fs.writeFileSync(logPath, frameLog(buildResumeLog(repaired.rows, { id, createdAt: session.createdAt, cwd })))
      fs.writeFileSync(path.join(target, 'session.lock'), '')
    }
    results.push({ ...session, rowsCount: repaired.rows.length, rowsFile, stats: repaired.stats, attachments, logPath, writeLog })
  }
  return { dir, home, cwd, sessionsDir, writeLog, dryRun, sessions: results }
}

/** 引擎插件入口：注册 `android/session/import`，并把结果写到 import-result.json 供 App 落库。 */
export function setupSessionImport(ctx, { home, cwd }) {
  const methods = new Map()
  // 只取消一个会话的回答（agent.cancel），不再用 shutdown 把整个引擎停掉
  methods.set('android/session/stop', async (params = {}) => {
    const id = params?.sessionId
    if (typeof id !== 'string' || id === '') throw new TypeError('android/session/stop requires a sessionId string')
    const agents = ctx.get('agents')
    const agent = agents?.get?.(id) ?? agents?.list?.().find(a => String(a.session?.id) === id)
    if (agent && agent.status === 'running') agent.cancel({ kind: 'user' })
    return {}
  })
  methods.set(METHOD, async (params = {}) => {
    const dir = typeof params.dir === 'string' && params.dir !== '' ? params.dir : path.join(home, 'android', 'import-sessions')
    if (!fs.existsSync(dir)) return { dir, sessions: [], missing: true }
    const out = importSessions({ dir, home, cwd, writeLog: params.writeLog === true, dryRun: params.dryRun === true, only: typeof params.only === 'string' && params.only !== '' ? params.only : null })
    if (!out.dryRun) {
      const resultFile = path.join(home, 'android', RESULT_FILE)
      fs.mkdirSync(path.dirname(resultFile), { recursive: true })
      // rows 可能很大，落盘时精简：App 只要会话元数据 + 事件行
      fs.writeFileSync(resultFile, JSON.stringify({
        at: Date.now(), dir, writeLog: out.writeLog,
        sessions: out.sessions.map(s => ({ ...s, logPath: undefined, rowsFile: undefined })),
      }))
    }
    return { ...out, sessions: out.sessions.map(s => ({ ...s, logPath: undefined, rowsFile: undefined })) }
  })
  ctx.on('sdk-extensions/resolve', method => methods.get(method))
  return methods
}
