// Third gate: does the bundle need services only the DSH web app provides? Each row module the
// bundle inserts is imported in a worker thread (same risk as running it, just earlier) and its
// `inject` declaration read; the required names are intersected with ANDROID_UNAVAILABLE_SERVICES.
// Unknown missing services are not refused (another plugin may provide them); the plugin then
// shows as "waiting". A worker error or the 10 s timeout skips the gate.
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

/** Services dsh's web/desktop compositions mount and the android composition does not. */
export const ANDROID_UNAVAILABLE_SERVICES = Object.freeze([
  'connection', 'sessionController', 'workspaceRegistry', 'webServer', 'webserver', 'modules', 'jobController',
  'terminalController', 'workspaceFiles', 'directoryPicker', 'pluginInventory', 'webStartup', 'settingsController',
  'fileUploads',
])

/**
 * @param modules [{ rowId, specifier, from }] — `from` is the file URL imports resolve against
 * @param fallbackFrom file URL of the engine's install anchor (peers resolve there)
 * @returns { rows: [{ rowId, inject: string[], error? }], unavailable: string[] } or { skipped: reason }
 */
export function precheckBundle(modules, fallbackFrom, timeoutMs = 10000) {
  return new Promise(resolve => {
    let worker
    try {
      worker = new Worker(fileURLToPath(new URL('./precheck-worker.mjs', import.meta.url)), {
        workerData: { modules, fallbackFrom },
        stdout: true, stderr: true, // a plugin's top-level logging stays out of the engine log
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      })
    } catch (error) { resolve({ skipped: String(error?.message ?? error) }); return }
    const timer = setTimeout(() => { void worker.terminate(); resolve({ skipped: `timed out after ${timeoutMs} ms` }) }, timeoutMs)
    worker.once('message', result => {
      clearTimeout(timer)
      void worker.terminate()
      const unavailable = [...new Set(result.rows.flatMap(r => r.inject ?? []).filter(s => ANDROID_UNAVAILABLE_SERVICES.includes(s)))]
      resolve({ rows: result.rows, unavailable })
    })
    worker.once('error', error => { clearTimeout(timer); resolve({ skipped: String(error?.message ?? error) }) })
    worker.once('exit', code => { clearTimeout(timer); resolve({ skipped: `worker exited with ${code}` }) })
  })
}
