import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect, Plugin } from 'vite'

const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'connection',
  'content-length',
  'accept-encoding',
  'user-agent',
  'x-qp-target',
])

const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
])

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Same-origin bridge for providers which do not support browser CORS. */
export function llmProxyPlugin(): Plugin {
  const handle = async (req: Connect.IncomingMessage, res: ServerResponse) => {
    const target = req.headers['x-qp-target']
    if (typeof target !== 'string' || !/^https?:\/\//.test(target)) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: { message: '缺少有效的 x-qp-target 请求头' } }))
      return
    }
    const abort = new AbortController()
    const onRequestClose = () => {
      if (!req.complete) abort.abort()
    }
    const onResponseClose = () => {
      if (!res.writableEnded) abort.abort()
    }
    req.on('close', onRequestClose)
    res.on('close', onResponseClose)
    try {
      const url = new URL(req.url ?? '/', target)
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value !== 'string') continue
        const normalized = key.toLowerCase()
        if (STRIP_REQUEST_HEADERS.has(normalized) || normalized.startsWith('sec-')) continue
        headers[normalized] = value
      }
      const body = await readBody(req)
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body: body && body.length > 0 ? new Uint8Array(body) : undefined,
        signal: abort.signal,
        redirect: 'manual',
      })
      res.statusCode = upstream.status
      upstream.headers.forEach((value, key) => {
        if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value)
      })
      if (!upstream.body) {
        res.end()
        return
      }
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
      res.end()
    } catch (error) {
      if (abort.signal.aborted) {
        res.destroy()
        return
      }
      if (!res.headersSent) {
        res.statusCode = 502
        res.setHeader('content-type', 'application/json')
      }
      res.end(JSON.stringify({ error: { message: `本地代理转发失败：${(error as Error).message}` } }))
    } finally {
      req.off('close', onRequestClose)
      res.off('close', onResponseClose)
    }
  }
  return {
    name: 'qp-llm-proxy',
    configureServer(server) {
      server.middlewares.use('/llm-proxy', handle)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/llm-proxy', handle)
    },
  }
}
