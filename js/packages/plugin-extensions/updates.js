// Update checks without spawning pnpm: one abbreviated packument request per plugin
// (`Accept: application/vnd.npm.install-v1+json`) over the same registry plan as installs.
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { fetchLinkJson } from './fetch-sources.js'

const ABBREVIATED = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8'

/** dist-tags.latest and its manifest from the first registry that answers. */
export async function latestOf(name, registries, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  let lastError
  for (const registry of registries) {
    const base = registry.replace(/\/?$/, '/')
    try {
      const url = `${base}${name.replace('/', '%2F')}`
      const doc = await fetchLinkJson(url, { urls: [url], fetchImpl, headers: { accept: ABBREVIATED }, timeoutMs, headerTimeoutMs: timeoutMs, bodyTimeoutMs: 3 * timeoutMs })
      const latest = doc?.['dist-tags']?.latest
      const manifest = latest === undefined ? undefined : doc.versions?.[latest]
      if (manifest === undefined) { lastError = new Error('no latest version'); continue }
      return { version: latest, manifest: { name, version: latest, ...manifest }, registry: base }
    } catch (error) { lastError = error }
  }
  throw lastError ?? new Error('no registry')
}

export function compatible(manifest, exemptions = {}) {
  try { const issue = evaluatePluginCompatibility(manifest, exemptions); return issue === undefined || issue.exempted } catch { return false }
}

/** Compare dotted versions (prerelease ignored for ordering ties). */
export function newer(a, b) {
  const parse = v => String(v).split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return String(a).includes('-') === false && String(b).includes('-')
}
