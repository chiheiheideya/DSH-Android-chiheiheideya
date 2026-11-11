// Worker of precheck.js: import each row module and report its required services.
// A row module resolves from its bundle's directory; bare specifiers that do not resolve from
// the plugin (its peers: @deepseek-ai/*, sharp) resolve from the engine, as dsh's runtime
// resolution maps them at boot.
import { register } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

const { modules, fallbackFrom } = workerData
const PREFIX = 'dsh-precheck:'
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(${JSON.stringify(PREFIX)})) {
    const { from, spec } = JSON.parse(decodeURIComponent(specifier.slice(${PREFIX.length})))
    return next(spec, { ...context, parentURL: from })
  }
  try { return await next(specifier, context) } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || /^[./]|^[a-z]+:/i.test(specifier)) throw error
    return next(specifier, { ...context, parentURL: ${JSON.stringify(fallbackFrom)} })
  }
}`
register('data:text/javascript,' + encodeURIComponent(hooks))

function requiredServices(plugin) {
  const inject = plugin?.inject
  if (!inject) return []
  if (Array.isArray(inject)) return inject.filter(s => typeof s === 'string')
  if (typeof inject === 'object') {
    if (Array.isArray(inject.required)) return inject.required.filter(s => typeof s === 'string')
    return Object.keys(inject)
  }
  return []
}

const rows = []
for (const { rowId, specifier, from } of modules) {
  try {
    const ns = await import(PREFIX + encodeURIComponent(JSON.stringify({ from, spec: specifier })))
    const plugin = ns.default ?? ns
    rows.push({ rowId, inject: requiredServices(plugin) })
  } catch (error) {
    rows.push({ rowId, inject: [], error: String(error?.message ?? error).slice(0, 300) })
  }
}
parentPort.postMessage({ rows })
