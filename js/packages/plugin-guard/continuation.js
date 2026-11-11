// Long tasks (#37): how a turn ends, and harness-level continuation.
//
// dsh's loop has no step limit: a turn ends when the model answers without a tool call
// (`completed`), on the output cap (`max-tokens`), when a pre-step hook refuses (`blocked`, e.g. a
// budget), on an error, or when the run is stopped (`aborted`). A model working through a long list
// often answers with plain text in the middle ("not stopped, the next round continues
// automatically") — that is a `completed` turn, and nothing continues.
//
// So, at dsh's `agent/turn-stopping` boundary of a root session (the turn would end and nothing is
// queued for the next step):
//   - the current turn's todo list (`todo_write`, turn-scoped like dsh's `todos` projection) is the
//     source of truth: with open items, or with a reply that claims it will go on by itself, and no
//     question to the user, the turn continues with a short nudge injected as the next step (the
//     session stays `running`; the app sees one turn);
//   - capped: no second nudge when the model answered the previous one without calling a tool, and at
//     most CONTINUE_LIMIT nudges per turn;
//   - when the turn does end, an ignorable session record `plugin:android-guard/turn-outcome
//     { turn, reason, todos, nudges }` says why: done | needs_user | pending_work (stopped with open
//     todos despite a nudge) | continue_limit; plugin-guard's budget refusal records `budget`.
//     `turn/end`'s own reason covers the rest (error, aborted, max-tokens).
import { randomUUID } from 'node:crypto'

export const OUTCOME_TYPE = 'plugin:android-guard/turn-outcome'
/** `source.kind` of the injected continuation message (the app shows it as a notice, not as the user's). */
export const CONTINUE_SOURCE = 'android-continue'
/** Nudges per turn; each one after the first needs real progress (a tool call) since the previous one. */
export const CONTINUE_LIMIT = 8

/** A reply that says the work goes on by itself (it cannot: a reply without a tool call ends the turn). */
const CLAIMS_CONTINUATION = /自动继续|下一轮|下轮|稍后继续|继续处理中|仍在(处理|进行|执行)|还在(处理|进行|执行)|未停止|没有停止|并未停止|(will|going to) (continue|keep going|resume)|continu\w* automatically|next round|still (working|processing|running)/i
/** A reply that waits for the user: ends with a question, or asks for a decision or input. */
const ASKS_USER = /[?？][\s)）」』"'*_~`]*$|请(你|您)?(确认|选择|决定|告诉|提供|回复)|需要(你|您)(确认|选择|决定|提供|登录|操作)|是否(继续|需要|要)|要不要|(你|您)(来|先)(决定|定|看)|由(你|您)|等你|告诉我|回复我|你希望|你想要|please (confirm|choose|tell|let me know)|do you want|should i\b/i

const textOf = content => Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n').trim() : ''

/** Todo counts of a `todo/write` list (null without one). */
export function todoCounts(todos) {
  if (!Array.isArray(todos)) return null
  const n = status => todos.filter(t => t?.status === status).length
  return { pending: n('pending'), inProgress: n('in_progress'), completed: n('completed') }
}

/** Prompts the app sends for the user (继续 on an end card, crash / network recovery) start with this. */
const APP_PROMPT_PREFIX = '[DSH] '

/**
 * What the events of one open turn say about stopping now. `events` = the turn's events from its
 * `turn/start` (the stopping boundary: the last step ended and nothing is queued). `earlier` = the
 * todo list written before this turn: it counts only when the turn continues a task the app
 * resumed (an app prompt), so 继续 keeps the progress even before the model rewrites the list.
 * @returns `{ continue: true, todos, open, nudges, claims }` or `{ continue: false, reason, todos, nudges }`.
 */
export function assessStop(events, { limit = CONTINUE_LIMIT, earlier = null } = {}) {
  const resumed = events.some(e => e?.type === 'user/message' && e.data?.source?.kind === 'user' && textOf(e.data?.content).startsWith(APP_PROMPT_PREFIX.trim()))
  let todos = resumed ? earlier : null
  let lastAssistant
  let nudges = 0
  let callsSinceNudge = 0
  for (const e of events) {
    if (e?.type === 'todo/write') todos = e.data?.todos ?? null
    else if (e?.type === 'assistant/message') lastAssistant = e
    else if (e?.type === 'tool/call') callsSinceNudge++
    else if (e?.type === 'user/message' && e.data?.source?.kind === CONTINUE_SOURCE) { nudges++; callsSinceNudge = 0 }
  }
  const counts = todoCounts(todos)
  const open = counts === null ? 0 : counts.pending + counts.inProgress
  const content = lastAssistant?.data?.message?.content
  const endedByTool = Array.isArray(content) && content.some(b => b?.type === 'tool-call')
  const text = textOf(content)
  const claims = CLAIMS_CONTINUATION.test(text)
  const stop = reason => ({ continue: false, reason, todos: counts, nudges })
  // A tool concluded the turn (or no answer at all): nothing to judge.
  if (lastAssistant === undefined || endedByTool) return stop('done')
  if (open === 0 && !claims) return stop('done')
  if (ASKS_USER.test(text)) return stop('needs_user')
  // Open todos or a claim that it goes on, and the previous nudge brought no tool call: the model insists.
  if (nudges > 0 && callsSinceNudge === 0) return stop('pending_work')
  if (nudges >= limit) return stop('continue_limit')
  const next = Array.isArray(todos) ? todos.find(t => t?.status === 'in_progress') ?? todos.find(t => t?.status === 'pending') : undefined
  return { continue: true, todos: counts, open, next: next?.content, nudges, claims }
}

/** The model-facing continuation message text. */
export function nudgeText({ open, next, nudges, claims }, limit = CONTINUE_LIMIT) {
  const why = open > 0
    ? `your todo list still has ${open} open item(s)${next ? ` (next: ${JSON.stringify(next)})` : ''}`
    : 'your reply says the work will go on, but nothing runs between turns'
  return `Automatic continuation ${nudges + 1}/${limit}: you answered without calling a tool, which ends the task, and ${why}. ` +
    'There is no automatic "next round": work only happens while you call tools. Continue now with the next item. ' +
    'Do not repeat actions that already succeeded (check the todo list and the results above) and keep the todo list current. ' +
    'If you really cannot go on (you need the user\'s decision or input, the app blocks or rate-limits you, or it is unsafe), stop and say so plainly: what was done, what remains, and what you need. If the only reason you stopped is that you need the user\'s answer or decision, ask the user directly now — do not continue on assumptions.' +
    (claims && open === 0 ? ' If the task is in fact finished, give the final reply.' : '')
}

let defaultRecord
let defaultMessage
/** Appends an ignorable plugin record (dsh-session's appendPluginRecord, like plugin-mode). */
async function appendRecord(session, type, data) {
  defaultRecord ??= import('@deepseek-ai/dsh-session').then(m => m.appendPluginRecord).catch(() => null)
  const append = await defaultRecord
  if (typeof append === 'function') append(session, type, data)
}
async function userMessage(input) {
  defaultMessage ??= import('@deepseek-ai/dsh-llm').then(m => m.createUserMessage).catch(() => null)
  const create = await defaultMessage
  return typeof create === 'function' ? create(input) : Object.freeze({ ...input, role: 'user', id: randomUUID() })
}

/** The open turn's events (from its `turn/start`) and the last todo list written before it. */
function openTurnEvents(session, turn) {
  const events = session.snapshotEvents?.() ?? []
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.type !== 'turn/start' || (turn !== undefined && e.data?.turn !== turn)) continue
    let earlier = null
    for (let j = i - 1; j >= 0; j--) if (events[j]?.type === 'todo/write') { earlier = events[j].data?.todos ?? null; break }
    return { events: events.slice(i), earlier }
  }
  return { events: [], earlier: null }
}

/**
 * Installs the continuation at `agent/turn-stopping` and returns `record(session, data)` for other
 * turn-ending decisions (the budget refusal). Options: `limit`, `log(ctx, level, text)`,
 * `appendRecord`, `createMessage` (tests).
 */
export function setupContinuation(ctx, { limit = CONTINUE_LIMIT, log = () => {}, appendRecord: append = appendRecord, createMessage = userMessage } = {}) {
  const record = (session, data) => Promise.resolve(append(session, OUTCOME_TYPE, data)).catch(error => log(ctx, 'warn', `turn outcome not recorded: ${error?.message ?? error}`))
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const session = agent?.session
    if (session === undefined || signal?.aborted) return
    // Subagents report to their parent through their result; only the conversation is continued.
    if (session.header?.parentSession !== undefined) return
    let verdict
    try {
      const { events, earlier } = openTurnEvents(session, turn)
      verdict = assessStop(events, { limit, earlier })
    } catch (error) {
      log(ctx, 'warn', `continuation check failed: ${error?.message ?? error}`)
      return
    }
    if (!verdict.continue) {
      await record(session, { turn, reason: verdict.reason, todos: verdict.todos, nudges: verdict.nudges })
      return
    }
    const text = nudgeText(verdict, limit)
    const message = await createMessage({
      content: [{ type: 'text', text }],
      source: { kind: CONTINUE_SOURCE, form: 'notice', summary: `continue ${verdict.nudges + 1}/${limit}: ${verdict.open} open` },
    })
    if (signal?.aborted) return
    log(ctx, 'info', `turn ${turn} of ${session.id}: model stopped with ${verdict.open} open todo(s)${verdict.claims ? ' claiming it continues' : ''}; continuing (${verdict.nudges + 1}/${limit})`)
    agent.inject(message)
  })
  return { record }
}
