// @dsh-android/plugin-account — DeepSeek account login for the phone
// (docs/ENGINE-CONTRACT.md §2.4).
//
// dsh-base already mounts the account stack: `deepseek-account`
// (@deepseek-ai/dsh-deepseek-account-platform: system-browser OAuth + PKCE
// against platform.deepseek.com, grant in the local credential store,
// resolveToken for model/search requests, profile/balance, expiry, sign-out)
// and the `deepseek-account` model route (@deepseek-ai/dsh-llm-deepseek-account).
// Two things are missing in an SDK composition, and this plugin adds them:
//
// 1. The Host webServer the provider registers `/oauth/callback` on. Here it is
//    a loopback-only server (127.0.0.1, OS-assigned port, opened on the first
//    sign-in) whose completion page sends the Custom Tab back to the app.
// 2. The account RPC surface. dsh's AccountController is a Typert Remote for the
//    Web gateway; the phone talks the SDK JSON-RPC channel, so the same
//    operations are contributed as SDK methods through the `sdkExtensions`
//    service (patch 10) and account events become SDK notifications.
//
// Methods (app → engine), params/results are JSON:
//   account/state                    → AccountView
//   account/details      {client?}   → { profile, balance }       (null fields when signed out)
//   account/sign-in/start {client?}  → AccountView                (attempt.phase 'initializing')
//   account/sign-in/cancel {attemptId} → AccountView
//   account/sign-out     {client?}   → AccountView
//   account/tasks/running            → { running: boolean }
// Notifications (engine → app):
//   account.changed {view}  account.session-expired {}  account.signed-out {}
//   account.model-sign-in-required {}  account.callback {result}
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { isRunningAccountTask } from '@deepseek-ai/dsh-deepseek-account'
import { createLoopbackServer } from './loopback.js'

export const name = 'android-account'
export const inject = ['deepseekAccount']

function log(level, message) {
  process.stderr.write(`[android-account] ${level === 'info' ? '' : level + ': '}${message}\n`)
}

const str = v => typeof v === 'string' && v.length > 0 ? v : undefined

/** The AccountClientMetadata dsh derives the Platform client headers from. */
export function clientMetadata(raw, fallbackLocale) {
  const offset = raw?.timezoneOffsetSeconds
  return {
    version: str(raw?.version) ?? APP_IDENTITY.version,
    locale: str(raw?.locale) ?? (fallbackLocale || 'en'),
    timezoneOffsetSeconds: Number.isSafeInteger(offset) ? offset : -new Date().getTimezoneOffset() * 60,
  }
}

/** Client-safe projection of the account state (already credential-free in dsh; copied defensively). */
export function viewOf(state) {
  const attempt = state?.attempt
  return {
    status: state?.status === 'credential-stored' ? 'credential-stored' : 'signed-out',
    links: { usageUrl: state?.links?.usageUrl ?? null, topUpUrl: state?.links?.topUpUrl ?? null },
    attempt: attempt == null ? null : {
      id: attempt.id,
      phase: attempt.phase,
      ...attempt.authorizeUrl === undefined ? {} : { authorizeUrl: attempt.authorizeUrl },
      ...attempt.expiresAt === undefined ? {} : { expiresAt: attempt.expiresAt },
      ...attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode },
    },
  }
}

export function apply(ctx, config = {}) {
  const account = () => ctx.deepseekAccount
  const locale = () => str(config.locale) ?? process.env.DSH_ANDROID_LOCALE ?? 'en'
  const notify = (method, params = {}) => ctx.emit('sdk-extensions/notify', method, params)

  // ── 1. loopback callback server (the provider's `webServer`) ──────────────
  const loopback = createLoopbackServer({
    locale,
    scheme: str(config.appScheme) ?? 'dsh-android',
    appPackage: str(config.appPackage) ?? str(process.env.DSH_ANDROID_PACKAGE),
    onComplete: result => notify('account.callback', { result }),
    log: m => log('warn', m),
  })
  ctx.provide('webServer', loopback)
  ctx.effect(() => () => loopback.close(), 'android-account: loopback server')

  // ── 2. SDK methods ─────────────────────────────────────────────────────────
  const details = async (client) => {
    const read = async (query) => {
      try { return await query() } catch (error) {
        log('warn', `account read failed: ${error?.code ?? error?.message ?? error}`)
        return { status: 'failed' }
      }
    }
    const [profile, balance] = await Promise.all([
      read(() => account().getProfile(client)),
      read(() => account().getBalance(client)),
    ])
    return { profile: profile ?? null, balance: balance ?? null }
  }
  const methods = new Map([
    ['account/state', async () => viewOf(await account().getState())],
    ['account/details', params => details(clientMetadata(params?.client, locale()))],
    ['account/sign-in/start', async (params) => {
      const fresh = loopback.port === undefined
      const origin = await loopback.listen()
      if (fresh) log('info', `login callback server on ${origin}`)
      return viewOf(await account().startSignIn(clientMetadata(params?.client, locale()), origin, 'web'))
    }],
    ['account/sign-in/cancel', async (params) => {
      if (typeof params?.attemptId !== 'string') throw new TypeError('account/sign-in/cancel requires an attemptId string')
      return viewOf(await account().cancelSignIn(params.attemptId))
    }],
    ['account/sign-out', async params => viewOf(await account().signOut(clientMetadata(params?.client, locale())))],
    ['account/tasks/running', () => ({ running: (ctx.get('agents')?.list() ?? []).some(isRunningAccountTask) })],
  ])
  const extensions = { resolve: method => methods.get(method), methods: () => [...methods.keys()] }
  ctx.provide('sdkExtensions', extensions)

  // ── 3. notifications ──────────────────────────────────────────────────────
  ctx.on('deepseek-account/session-expired', () => notify('account.session-expired'))
  ctx.on('deepseek-account/signed-out', () => notify('account.signed-out'))
  ctx.on('deepseek-account/model-sign-in-required', () => notify('account.model-sign-in-required'))
  ctx.effect(() => {
    const lifetime = new AbortController()
    ;(async () => {
      for await (const state of account().watch(lifetime.signal)) notify('account.changed', { view: viewOf(state) })
    })().catch(error => { if (!lifetime.signal.aborted) log('warn', `account stream ended: ${error?.message ?? error}`) })
    return () => lifetime.abort()
  }, 'android-account: state stream')
}
