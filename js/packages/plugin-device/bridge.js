// Newline-delimited JSON-RPC 2.0 peer over the capability socket (ENGINE-CONTRACT §3).
// Both directions: Node sends requests (capability/list, capability/invoke) and
// receives notifications (capability/changed, budget/update). Requests from the
// app are answered with -32601 (the contract defines none).
import net from 'node:net'
import { EventEmitter } from 'node:events'

const MAX_LINE_BYTES = 64 * 1024 * 1024 // screenshots arrive base64-encoded in one line

export class BridgeClosedError extends Error {
  constructor(message = 'capability bridge is closed') {
    super(message)
    this.name = 'BridgeClosedError'
    this.code = 'BRIDGE_CLOSED'
  }
}

export class BridgeRpcError extends Error {
  constructor(error) {
    super(typeof error?.message === 'string' ? error.message : 'capability bridge error')
    this.name = 'BridgeRpcError'
    this.rpcCode = error?.code
    this.data = error?.data
  }
}

/**
 * JSON-RPC peer on an already-open stream (a socketpair end). Emits
 * `notification` (method, params) and `close` (error?).
 */
export class BridgePeer extends EventEmitter {
  #socket
  #buffer = ''
  #nextId = 1
  #pending = new Map()
  #closed = false

  /** @param {import('node:stream').Duplex} socket */
  constructor(socket) {
    super()
    this.#socket = socket
    socket.setEncoding('utf8')
    socket.on('data', chunk => this.#onData(chunk))
    socket.on('error', error => this.#close(error))
    socket.on('close', () => this.#close())
    socket.on('end', () => this.#close())
  }

  /** Open a peer on a numeric file descriptor (DSH_BRIDGE_FD). */
  static fromFd(fd) {
    const socket = new net.Socket({ fd, readable: true, writable: true, allowHalfOpen: false })
    return new BridgePeer(socket)
  }

  get closed() { return this.#closed }

  /** Do not keep the event loop alive just for the bridge. */
  unref() { this.#socket.unref?.(); return this }

  request(method, params, { signal, timeoutMs } = {}) {
    if (this.#closed) return Promise.reject(new BridgeClosedError())
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      let timer
      const cleanup = () => {
        this.#pending.delete(id)
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(signal.reason instanceof Error ? signal.reason : new Error('capability request aborted'))
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup()
          reject(Object.assign(new Error(`capability request ${method} timed out after ${timeoutMs}ms`), { code: 'BRIDGE_TIMEOUT' }))
        }, timeoutMs)
      }
      this.#pending.set(id, {
        resolve: value => { cleanup(); resolve(value) },
        reject: error => { cleanup(); reject(error) },
      })
      this.#write({ jsonrpc: '2.0', id, method, params: params ?? {} })
    })
  }

  notify(method, params) {
    if (this.#closed) return
    this.#write({ jsonrpc: '2.0', method, params: params ?? {} })
  }

  close() {
    this.#close()
    this.#socket.destroy()
  }

  #write(message) {
    this.#socket.write(JSON.stringify(message) + '\n')
  }

  #onData(chunk) {
    this.#buffer += chunk
    if (this.#buffer.length > MAX_LINE_BYTES && !this.#buffer.includes('\n')) {
      this.#close(new Error('capability bridge frame exceeds the size limit'))
      this.#socket.destroy()
      return
    }
    let newline
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.emit('protocol-error', new Error('capability bridge sent a non-JSON line'))
        continue
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message) {
    if (message === null || typeof message !== 'object') return
    const hasId = message.id !== undefined && message.id !== null
    if (typeof message.method === 'string') {
      if (hasId) {
        this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
      } else {
        this.emit('notification', message.method, message.params ?? {})
      }
      return
    }
    if (!hasId) return
    const pending = this.#pending.get(message.id)
    if (pending === undefined) return
    if (message.error !== undefined) pending.reject(new BridgeRpcError(message.error))
    else pending.resolve(message.result)
  }

  #close(error) {
    if (this.#closed) return
    this.#closed = true
    for (const pending of [...this.#pending.values()]) pending.reject(new BridgeClosedError(error ? `capability bridge failed: ${error.message}` : undefined))
    this.#pending.clear()
    this.emit('close', error)
  }
}
