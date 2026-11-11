// UserError: what the app shows when an extension operation fails or a plugin cannot run.
//   { code, message, params, detail?, logPath?, actions? }
// `message` is one human sentence in the engine locale (zh for zh-*, else en); `params` carries
// the same facts so the app may render its own text. Codes are the contract
// (docs/PLUGINS-CONTRACT.md §5); the app must treat an unknown code as a generic failure.
// Sources: the pnpmfile gate (`DSHA_NATIVE <pkg>@<ver> <code> <detail>`), our scan and
// precheck, dsh's plugin manager (ManagementError codes, pnpm failure kinds, incompatible[]).

import { LinkTooLargeError, SourcesError, codeOf, reasonOf } from './fetch-sources.js'

const ZH = {
  'native-addon': p => `无法安装 ${p.name}：它依赖原生模块 ${p.pkg}（要为电脑编译的二进制程序），手机上的 DSH 运行不了这类插件。`,
  'prebuilt-binary': p => `无法安装 ${p.name}：它的包 ${p.pkg} 里带有电脑专用的二进制文件（${p.file}），手机上无法加载。已撤销安装。`,
  'needs-desktop-browser': p => `无法安装 ${p.name}：它要用电脑上的浏览器（${p.pkg}），手机上没有。`,
  'needs-web-services': p => `${p.name} 需要 DSH 网页版才有的服务（${p.labels}），手机版没有，暂时用不了。已撤销安装。`,
  'not-bundle': p => `${p.name} 不是 DSH 插件（package.json 里没有 dsh.bundle 声明）。如果它是 MCP 服务器，请到「MCP 服务」里添加。`,
  'incompatible-version': p => `${p.name} ${p.version ?? ''} 需要 DSH 引擎 ${p.range}，手机版目前是 ${p.dsh}。等 App 更新后再装，或者选择仍要安装。`,
  'not-found': p => `在 ${p.registry} 上找不到 ${p.name}。检查一下名字；刚发布的版本镜像可能还没同步，可以稍后再试或换到 npm 官方源。`,
  network: p => `连不上下载源 ${p.host}（${p.reason}）。检查网络或代理，或者换个下载源。`,
  integrity: () => '下载的文件校验没通过（和登记的 sha512 不一致），已中止。多半是网络或镜像的问题，换个下载源再试。',
  'no-space': () => '手机存储空间不足，装不下这个插件。',
  'needs-git': () => '这个地址需要 git 才能下载（ssh 地址或私有仓库），手机上没有 git。请改用 GitHub 网页链接或 npm 包名。',
  'needs-build': () => '这个 GitHub 仓库是源代码，要先构建才能用。请让作者发布到 npm，或者在 Releases 里附上 .tgz 包。',
  'github-unreachable': p => `访问 GitHub 失败（${p.reason}）。可以改用 npm 包名，或者下载 .tgz 后从文件安装。`,
  'index-unreachable': p => `连不上插件索引。试过：${p.tried}。检查网络或代理后重试。`,
  'link-unreachable': p => `下载 ${p.host} 上的文件失败。试过：${p.tried}。检查链接、网络或代理后重试。`,
  'link-is-page': p => `${p.host} 返回的是网页，不是文件。请改用文件的直链（GitHub 上点「Raw」得到的地址），或者直接粘贴 GitHub 仓库 / 目录链接。`,
  'link-too-large': p => `${p.host} 上的文件太大（超过 ${Math.round((p.maxBytes ?? 0) / 1048576)} MB），已中止。`,
  'index-invalid': p => `插件索引的内容有误（${p.reason}），请稍后重试或联系索引维护者。`,
  'bad-archive': () => '文件里找不到 package.json，看起来不是插件包。',
  'bad-input': p => `看不懂这个输入：${p.input}。请填 npm 包名、npm 或 GitHub 链接、.tgz/.zip 链接或本地文件。`,
  'already-installed': p => `${p.name} 已经装过了。要换版本请用「更新」。`,
  'installer-broken': () => '安装组件缺失（找不到 node 启动器或 pnpm），请重新安装 App。',
  'activation-failed': p => `${p.name} 已安装，但启动时出错：${p.error}。其他功能不受影响。`,
  'waiting-service': p => `${p.name} 在等待服务 ${p.services}，可能还缺它依赖的另一个插件。`,
  'crash-suspended': p => `${p.name} 让引擎崩溃了，已暂停它。`,
  'safe-mode': p => `${p.why === 'requested' ? '安全模式启动' : p.why === 'crash-loop' ? '引擎反复崩溃' : '引擎连续两次没能启动'}，已暂停全部 ${p.count} 个插件。可以逐个重新启用，找出有问题的那个。`,
  'restart-pending': () => '插件变更会在当前任务结束后生效。',
  'pnpm-failed': p => `安装没成功：${p.reason}。`,
  'not-installed': p => `${p.name} 没有安装。`,
  'not-removable': p => `${p.name} 是内置组件，不能卸载。`,
  'management-required': p => `${p.name} 是插件管理所需的内置组件，不能停用。`,
  busy: () => '另一个插件操作还没结束，请稍后再试。',
  cancelled: () => '已取消。',
  'skill-invalid': p => `${p.file} 不是有效的技能：缺少 ${p.missing}。`,
  'skill-scripts': p => `这个技能附带脚本（${p.ext}），手机上可能无法运行。`,
  'skill-exists': p => `已有同名技能 ${p.name}。`,
  'mcp-sse-only': () => '这个服务只提供旧版 SSE 接口，dsh 只支持 Streamable HTTP（通常是 …/mcp 地址）。',
  'mcp-runtime': p => `这个服务需要 ${p.runtime}，手机上没有，暂不支持。`,
  'mcp-local-path': () => '这个服务指向电脑上的本地文件，手机上不存在。请改用 npm 包名或远程地址。',
  'mcp-auth': p => `连接被拒绝（HTTP ${p.status}），检查令牌或请求头。`,
  'mcp-failed': p => `连接 MCP 服务失败：${p.reason}`,
  'mcp-too-many': p => `同时启用的本地 MCP 服务最多 ${p.limit} 个。`,
  unknown: p => `操作失败：${p.reason}`,
}

const EN = {
  'native-addon': p => `Cannot install ${p.name}: it depends on the native module ${p.pkg} (a binary built for computers), which DSH on a phone cannot run.`,
  'prebuilt-binary': p => `Cannot install ${p.name}: its package ${p.pkg} ships a computer-only binary (${p.file}) a phone cannot load. The installation was undone.`,
  'needs-desktop-browser': p => `Cannot install ${p.name}: it drives a desktop browser (${p.pkg}), which a phone does not have.`,
  'needs-web-services': p => `${p.name} needs services only the DSH web app has (${p.labels}); the phone app has none of them. The installation was undone.`,
  'not-bundle': p => `${p.name} is not a DSH plugin (its package.json declares no dsh.bundle). If it is an MCP server, add it under MCP servers.`,
  'incompatible-version': p => `${p.name} ${p.version ?? ''} needs DSH engine ${p.range}; this app has ${p.dsh}. Wait for an app update, or install anyway.`,
  'not-found': p => `${p.name} was not found on ${p.registry}. Check the name; a mirror may lag behind a fresh release — retry later or switch to the npm registry.`,
  network: p => `Cannot reach ${p.host} (${p.reason}). Check the network or proxy, or try another registry.`,
  integrity: () => 'The download does not match its registered sha512; aborted. Usually a network or mirror problem — try another registry.',
  'no-space': () => 'Not enough storage for this plugin.',
  'needs-git': () => 'This address needs git (ssh or a private repository), which a phone does not have. Use the GitHub web link or the npm package name.',
  'needs-build': () => 'This GitHub repository is source code that must be built first. Ask the author to publish it to npm or attach a .tgz to a release.',
  'github-unreachable': p => `GitHub could not be reached (${p.reason}). Use the npm package name, or download the .tgz and install it from a file.`,
  'index-unreachable': p => `Couldn't reach the plugin index. Tried: ${p.tried}. Check the network or proxy, then retry.`,
  'link-unreachable': p => `Couldn't download the file from ${p.host}. Tried: ${p.tried}. Check the link, the network or proxy, then retry.`,
  'link-is-page': p => `${p.host} answered with a web page, not a file. Use the file's direct link (GitHub's "Raw" button), or paste the GitHub repository / folder link.`,
  'link-too-large': p => `The file on ${p.host} is too large (over ${Math.round((p.maxBytes ?? 0) / 1048576)} MB); aborted.`,
  'index-invalid': p => `The plugin index is malformed (${p.reason}). Retry later or contact its maintainer.`,
  'bad-archive': () => 'No package.json in this file; it does not look like a plugin package.',
  'bad-input': p => `Cannot read this input: ${p.input}. Give an npm name, an npm or GitHub link, a .tgz/.zip link or a local file.`,
  'already-installed': p => `${p.name} is already installed. Use Update to change its version.`,
  'installer-broken': () => 'The installer is missing (node launcher or pnpm not found). Reinstall the app.',
  'activation-failed': p => `${p.name} is installed but failed to start: ${p.error}. Everything else keeps working.`,
  'waiting-service': p => `${p.name} is waiting for the service ${p.services}; it may need another plugin.`,
  'crash-suspended': p => `${p.name} crashed the engine and was suspended.`,
  'safe-mode': p => `${p.why === 'requested' ? 'Started in safe mode' : p.why === 'crash-loop' ? 'The engine kept crashing' : 'The engine failed to start twice in a row'}; all ${p.count} plugins were suspended. Re-enable them one by one to find the culprit.`,
  'restart-pending': () => 'Plugin changes apply after the current task ends.',
  'pnpm-failed': p => `The installation failed: ${p.reason}.`,
  'not-installed': p => `${p.name} is not installed.`,
  'not-removable': p => `${p.name} is built in and cannot be removed.`,
  'management-required': p => `${p.name} is built in and needed for plugin management.`,
  busy: () => 'Another plugin operation is still running; try again shortly.',
  cancelled: () => 'Cancelled.',
  'skill-invalid': p => `${p.file} is not a valid skill: ${p.missing} is missing.`,
  'skill-scripts': p => `This skill ships scripts (${p.ext}) that may not run on a phone.`,
  'skill-exists': p => `A skill named ${p.name} already exists.`,
  'mcp-sse-only': () => 'This server only offers the legacy SSE transport; dsh supports Streamable HTTP (usually a …/mcp URL).',
  'mcp-runtime': p => `This server needs ${p.runtime}, which a phone does not have.`,
  'mcp-local-path': () => 'This server points at a local file on a computer, which does not exist on the phone. Use an npm package or a remote URL.',
  'mcp-auth': p => `Connection refused (HTTP ${p.status}); check the token or headers.`,
  'mcp-failed': p => `Could not connect to the MCP server: ${p.reason}`,
  'mcp-too-many': p => `At most ${p.limit} local MCP servers can be enabled at once.`,
  unknown: p => `The operation failed: ${p.reason}`,
}

const ACTIONS = {
  'not-found': ['retry-mirror'],
  network: ['retry-mirror'],
  integrity: ['retry-mirror'],
  'incompatible-version': ['force-install'],
  'activation-failed': ['disable', 'uninstall', 'open-log'],
  'crash-suspended': ['resume', 'uninstall'],
  'safe-mode': ['resume'],
  'pnpm-failed': ['open-log'],
  'waiting-service': ['disable', 'uninstall'],
  'index-unreachable': ['retry'],
  'link-unreachable': ['retry'],
  'index-invalid': ['retry'],
}

/** Chinese names of the web-only services (needs-web-services). */
export const SERVICE_LABELS = {
  connection: ['网页连接', 'web connection'], sessionController: ['会话控制', 'session control'],
  workspaceRegistry: ['工作区', 'workspaces'], webServer: ['网页服务器', 'web server'], webserver: ['网页服务器', 'web server'],
  modules: ['网页模块', 'web modules'], jobController: ['后台任务', 'background jobs'], terminalController: ['终端', 'terminal'],
  workspaceFiles: ['工作区文件', 'workspace files'], directoryPicker: ['目录选择', 'directory picker'],
  pluginInventory: ['插件清单', 'plugin inventory'], webStartup: ['网页启动', 'web startup'], settingsController: ['设置界面', 'settings UI'],
  fileUploads: ['文件上传', 'file uploads'],
}

export const zh = () => /^zh\b/i.test(process.env.DSH_ANDROID_LOCALE ?? '')

/**
 * Display text from a plugin manifest / bundle metadata in the wire form of the `android/ext/*`
 * results (docs/PLUGINS-CONTRACT.md §2 "LocalizedText"): a non-blank string, or `{tag: text}` with
 * lower-case `-` tags and non-blank string values (`zh_CN` → `zh-cn`); undefined for anything else.
 * The engine owns this normalization; the app decodes both forms and falls back by locale.
 */
export function localizedText(value) {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string' || v.trim() === '' || !/^[A-Za-z]{2,8}([_-][A-Za-z0-9]{1,8})*$/.test(k)) continue
    out[k.toLowerCase().replace(/_/g, '-')] ??= v
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** One string from a LocalizedText for the engine locale (engine-made sentences, logs). */
export function localizedString(value, fallback = '') {
  const t = localizedText(value)
  if (t === undefined) return fallback
  if (typeof t === 'string') return t
  const lang = String(process.env.DSH_ANDROID_LOCALE ?? 'en').toLowerCase().replace(/_/g, '-')
  for (let tag = lang; tag !== ''; tag = tag.includes('-') ? tag.slice(0, tag.lastIndexOf('-')) : '') if (t[tag] !== undefined) return t[tag]
  const base = lang.split('-')[0]
  return Object.entries(t).find(([k]) => k.split('-')[0] === base)?.[1] ?? t.en ?? Object.values(t)[0]
}

/** Build a UserError. */
export function userError(code, params = {}, extra = {}) {
  const table = zh() ? ZH : EN
  const render = table[code] ?? table.unknown
  const p = { reason: '', ...params }
  let message
  try { message = render(p) } catch { message = String(params.reason ?? code) }
  return { code, message: message.replace(/\s+/g, ' ').trim(), params, ...ACTIONS[code] ? { actions: ACTIONS[code] } : {}, ...extra }
}

export function labelsOf(services) {
  const i = zh() ? 0 : 1
  return services.map(s => SERVICE_LABELS[s]?.[i] ?? s).join(zh() ? '、' : ', ')
}

/** `DSHA_NATIVE <pkg>@<ver> <code> <detail>` from the pnpmfile, wherever pnpm printed it. */
export function parseGateRefusal(text) {
  const m = /DSHA_NATIVE (\S+?)@(\S+) (native-addon|needs-desktop-browser) ?([^\n]*)/.exec(String(text ?? ''))
  return m === null ? undefined : { pkg: m[1], version: m[2], code: m[3], detail: m[4].trim() }
}

const firstLine = text => String(text ?? '').split('\n').map(l => l.trim()).find(l => l !== '' && !l.startsWith('android-env:')) ?? ''

/** The interesting line of a pnpm log for a one-line reason. */
export function pnpmReason(output) {
  const lines = String(output ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  return (lines.find(l => /ERR_PNPM|ERROR|error/.test(l)) ?? lines.at(-1) ?? '').slice(0, 300)
}

/**
 * Translate a plugin manager result (`PluginOperationResult`) that failed into a UserError.
 * @param result manager result with `error` / `packageResult` / `failedAt` / `registries`
 * @param context { name, dsh, registry }
 */
export function fromManagerResult(result, context = {}) {
  const output = [result?.packageResult?.output, result?.error?.diagnostic].filter(Boolean).join('\n')
  const logPath = result?.packageResult?.logPath
  const extra = { ...logPath ? { logPath } : {}, ...output ? { detail: output.slice(-4000) } : {} }
  const name = context.name ?? result?.bundle ?? result?.target ?? ''
  const gate = parseGateRefusal(output)
  if (gate !== undefined) return userError(gate.code, { name, pkg: `${gate.pkg}@${gate.version}`, why: gate.detail }, extra)
  const code = result?.error?.code
  if (code === 'incompatible-version') {
    const inc = result.error.incompatible?.[0] ?? {}
    return userError('incompatible-version', { name: inc.name ?? name, version: inc.version, range: rangeOf(inc), dsh: context.dsh ?? '' , incompatible: result.error.incompatible ?? [] }, extra)
  }
  if (code === 'not-bundle') return userError('not-bundle', { name }, extra)
  if (code === 'already-installed') return userError('already-installed', { name }, extra)
  if (code === 'not-removable') return userError('not-removable', { name }, extra)
  if (code === 'management-required') return userError('management-required', { name }, extra)
  if (code === 'invalid-spec') return userError('bad-input', { input: name }, extra)
  const kind = result?.packageResult?.kind
  const registry = result?.registries?.at(-1) ?? context.registry ?? ''
  const host = (() => { try { return new URL(registry).host } catch { return registry } })()
  switch (kind) {
    case 'pnpm-missing': return userError('installer-broken', {}, extra)
    case 'not-found': case 'no-matching-version': return userError('not-found', { name, registry: host }, extra)
    case 'network': case 'timeout': return userError('network', { host, reason: networkReason(output) }, extra)
    case 'integrity': return userError('integrity', {}, extra)
    case 'disk-full': return userError('no-space', {}, extra)
  }
  if (/ENOENT/.test(output) && /spawn/.test(output)) return userError('installer-broken', {}, extra)
  return userError('pnpm-failed', { reason: pnpmReason(output) || firstLine(result?.error?.diagnostic) || String(code ?? 'unknown') }, extra)
}

/** One fetch-sources reason (timeout | dns | refused | reset | tls | unreachable | http-<n> | network) in words. */
export function sourceReason(reason) {
  const z = zh()
  const http = /^http-(\d+)$/.exec(reason ?? '')
  if (http) return `HTTP ${http[1]}`
  const words = {
    timeout: ['连接超时', 'timed out'], dns: ['域名解析失败', 'DNS lookup failed'], refused: ['拒绝连接', 'connection refused'],
    reset: ['连接被重置', 'connection reset'], tls: ['证书错误', 'certificate error'], unreachable: ['网络不可达', 'network unreachable'],
    aborted: ['已取消', 'cancelled'],
  }[reason]
  return words ? words[z ? 0 : 1] : (z ? '网络错误' : 'network error')
}

/**
 * `host（原因 CODE）、host（原因）` for SourcesError attempts: the reason in words plus the root
 * cause's code (`UND_ERR_CONNECT_TIMEOUT`, `ECONNRESET`, …) when there is one, never a bare
 * "fetch failed". A source still waiting when another answered (`abandoned`) is left out.
 */
export function triedText(attempts) {
  const z = zh()
  return attempts.filter(a => a.reason !== 'abandoned').map(a => {
    const why = [sourceReason(a.reason), a.code].filter(Boolean).join(' ')
    return z ? `${a.host}（${why}）` : `${a.host} (${why})`
  }).join(z ? '、' : ', ')
}

/**
 * A failed download of a user-supplied link (fetchLink) as `[code, params]` for SourceError /
 * SkillError: `link-unreachable` naming every source tried and why, `link-too-large`, else
 * `link-unreachable` for a single URL with the root cause.
 */
export function linkFailure(error, url) {
  const hostOf = u => { try { return new URL(u).host } catch { return String(u) } }
  const host = hostOf(url)
  if (error instanceof LinkTooLargeError) return ['link-too-large', { url, host, maxBytes: error.maxBytes }]
  let attempts
  for (let e = error, i = 0; e != null && i < 6; e = e.cause, i++) if (e instanceof SourcesError) { attempts = e.attempts; break }
  if (attempts === undefined) {
    const code = codeOf(error)
    attempts = [{ url, host, reason: reasonOf(error), detail: String(error?.message ?? error).slice(0, 200), ...code ? { code } : {} }]
  }
  const shown = attempts.map(a => ({ host: a.host, url: a.url, reason: a.reason ?? 'network', ...a.detail ? { detail: a.detail } : {}, ...a.code ? { code: a.code } : {} }))
  return ['link-unreachable', { url, host, tried: triedText(shown), reason: triedText(shown), attempts: shown }]
}

export function networkReason(text) {
  const t = String(text ?? '')
  if (/ETIMEDOUT|timed out|TIMEOUT/i.test(t)) return zh() ? '超时' : 'timed out'
  if (/ECONNREFUSED/.test(t)) return zh() ? '拒绝连接' : 'connection refused'
  if (/ENOTFOUND|EAI_AGAIN|Could not resolve/.test(t)) return zh() ? '域名解析失败' : 'DNS lookup failed'
  if (/CERT|certificate|SSL|TLS/i.test(t)) return zh() ? '证书错误' : 'certificate error'
  if (/ERR_PNPM_FETCH_5\d\d|50\d/.test(t)) return zh() ? '服务器出错' : 'server error'
  return zh() ? '网络错误' : 'network error'
}

function rangeOf(inc) {
  const r = inc?.requirements ?? inc?.requires ?? inc
  if (typeof r === 'string') return r
  if (r && typeof r === 'object') {
    if (typeof r['engines.dsh'] === 'string') return r['engines.dsh']
    const first = Object.values(r).find(v => typeof v === 'string')
    if (first) return first
  }
  return '?'
}

/** A market failure (search / entry) as a UserError the app shows with 重试 and the sources tried. */
export function marketError(error, url) {
  const hostOf = u => { try { return new URL(u).host } catch { return String(u) } }
  const line = String(error?.message ?? error ?? '').split('\n')[0].slice(0, 300)
  for (let e = error, i = 0; e != null && i < 6; e = e.cause, i++) {
    if (e instanceof SourcesError) {
      const attempts = e.attempts.map(a => ({ host: a.host, url: a.url, reason: a.reason ?? 'network', ...a.detail ? { detail: a.detail } : {}, ...a.code ? { code: a.code } : {} }))
      return userError('index-unreachable', { url, tried: triedText(attempts), attempts }, { detail: line })
    }
  }
  if (error?.code === 'plugin-market/fetch-failed') {
    const status = /: HTTP (\d{3})$/.exec(error.message ?? '')?.[1]
    const code = status ? undefined : codeOf(error)
    const attempts = [{ host: hostOf(url), url, reason: status ? `http-${status}` : reasonOf(error), ...code ? { code } : {} }]
    return userError('index-unreachable', { url, tried: triedText(attempts), attempts }, { detail: line })
  }
  if (error?.code === 'plugin-market/invalid-index') return userError('index-invalid', { url, reason: line })
  return userError('unknown', { reason: line })
}
