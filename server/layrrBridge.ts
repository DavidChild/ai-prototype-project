import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import mysql from 'mysql2/promise'
import type { MysqlStorageConfig } from './mysqlStorage'
import { actorFromRequest, requireActor, resolveProjectAccess } from './saasAuth'
import { adaptLayrrWorkspaceOverlay } from './layrrOverlay'
import { htmlRevision, manualEditorShell, validateManualSave } from './layrrManual'
import { gridstackEditorShell } from './gridstackEditor'

const require = createRequire(import.meta.url)
const LIMIT = 5 * 1024 * 1024
const IDLE_SESSION_MS = 10 * 60 * 1000
type EditAttachment = { name: string; mimeType: string; base64: string }
type Edit = {
  instruction: string
  selector: string
  elements?: { selector: string }[]
  attachments?: EditAttachment[]
}
type Submission = {
  id: string
  html: string
  feedbackText: string
  source: 'layrr' | 'ai-local'
  originalHtml?: string
}
type SubmissionResult = { id: string; success: boolean; message: string; revision: string; feedbackText: string }
function submissionFor(input: Record<string, unknown>, html: string): Submission | null {
  if (input.submit !== true) return null
  const feedbackText = typeof input.feedbackText === 'string' ? input.feedbackText.trim() : ''
  if (!feedbackText || feedbackText.length > 500) throw new Error('请输入 1–500 字的版本修改备注')
  const id = input.submissionId ?? randomBytes(12).toString('hex')
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(id)) throw new Error('无效的提交标识')
  return { id, html, feedbackText, source: 'layrr' }
}
async function saveDocument(session: {
  file: string
  writing: boolean
  job: unknown
  submission: Submission | null
  submissionResults: Map<string, SubmissionResult>
}, input: Record<string, unknown>) {
  const submission = submissionFor(input, typeof input.html === 'string' ? input.html : '')
  const completed = submission && session.submissionResults.get(submission.id)
  if (completed) {
    if (completed.revision !== htmlRevision(submission.html) || completed.feedbackText !== submission.feedbackText)
      throw new Error('提交信息与已保存记录不一致')
    return { ok: true, revision: completed.revision, submissionId: submission.id }
  }
  if (submission && session.submission?.id === submission.id) {
    if (session.submission.html !== submission.html || session.submission.feedbackText !== submission.feedbackText)
      throw new Error('提交信息与正在保存的内容不一致')
    return { ok: true, revision: htmlRevision(submission.html), submissionId: submission.id }
  }
  if (session.writing || session.job || session.submission) throw new Error('已有修改进行中，请稍候或重新载入')
  session.writing = true
  try {
    const current = await readFile(session.file, 'utf8')
    const html = validateManualSave(input, current, false)
    await writeFile(session.file, html, 'utf8')
    session.submission = submission
    return { ok: true, revision: htmlRevision(html), submissionId: submission?.id }
  } finally {
    session.writing = false
  }
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk)
    if (size > LIMIT) throw new Error('请求过大')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function validateEditAttachments(value: unknown): EditAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 1) throw new Error('一次只能携带一张参考图')
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('参考图数据无效')
    const input = item as Record<string, unknown>
    const mimeType = typeof input.mimeType === 'string' ? input.mimeType : ''
    const base64 = typeof input.base64 === 'string' ? input.base64.replace(/\s+/g, '') : ''
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '参考图'
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType))
      throw new Error('参考图仅支持 PNG、JPG 或 WebP')
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || Math.ceil(base64.length * 0.75) > 2 * 1024 * 1024)
      throw new Error('参考图无效或超过 2 MB')
    return { name: name || '参考图', mimeType, base64 }
  })
}

function prepareLayrrPreviewHtml(html: string): string {
  // The random, same-origin workspace has its own response CSP. Remove prototype
  // http-equiv directives so they cannot block Layrr or navigate the editor away.
  return html.replace(/<meta\b[^>]*\bhttp-equiv\b[^>]*>/gi, '')
}

/** Uses the official Layrr overlay, with a 小豆原型 provider/patch adapter instead of a CLI agent. */
export function layrrBridgePlugin(
  config: MysqlStorageConfig,
  authorization = { actorFromRequest, requireActor, resolveProjectAccess },
): Plugin {
  const authPool = mysql.createPool({ ...config, connectionLimit: 4, supportBigNumbers: true, charset: 'utf8mb4' })
  const configure = (vite: ViteDevServer | PreviewServer) => {
      const sessions = new Map<
        string,
        {
          file: string
          url: string
          projectId: string
          pageId: string
          baseline: string
          writing: boolean
          submission: Submission | null
          submissionResults: Map<string, SubmissionResult>
          job: { id: string; edit: Edit; delivered: boolean } | null
          lastResult: { success: boolean; message: string; timestamp: number } | null
          sockets: Set<WebSocket>
          lastAccessAt: number
          close: () => void
        }
      >()
      vite.middlewares.use((req, res, next) => {
        const match = (req.url ?? '').match(/^\/preview\/([a-f0-9]{48})(?:\/|$)/)
        if (!match) {
          next()
          return
        }
        const session = sessions.get(match[1]!)
        if (!session) {
          res.statusCode = 404
          res.end('工作区已关闭')
          return
        }
        if (!isSameOrigin(req)) {
          res.statusCode = 403
          res.end('不允许跨站访问工作区')
          return
        }
        session.lastAccessAt = Date.now()
        const target = new URL(req.url ?? '/', session.url)
        const headers = { ...req.headers, host: target.host }
        if (headers.origin) headers.origin = `${target.protocol}//${target.host}`
        const upstream = httpRequest(target, { method: req.method, headers }, (upstreamRes) => {
          res.statusCode = upstreamRes.statusCode ?? 502
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (value !== undefined) res.setHeader(name, value)
          }
          upstreamRes.pipe(res)
        })
        upstream.on('error', (error) => {
          if (res.headersSent) {
            res.destroy(error)
            return
          }
          res.statusCode = 502
          res.end('工作区代理失败')
        })
        req.pipe(upstream)
      })

      const previewProxyWss = new WebSocketServer({ noServer: true })
      const handlePreviewUpgrade = (
        request: IncomingMessage,
        socket: Parameters<WebSocketServer['handleUpgrade']>[1],
        head: Buffer,
      ) => {
        const match = (request.url ?? '').match(
          /^\/preview\/([a-f0-9]{48})\/__layrr__\/ws$/,
        )
        if (!match) return
        const session = sessions.get(match[1]!)
        if (!session || !isSameOrigin(request)) {
          socket.destroy()
          return
        }
        session.lastAccessAt = Date.now()
        previewProxyWss.handleUpgrade(request, socket, head, (client) => {
          const target = new URL(request.url!, session.url)
          target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
          const upstream = new WebSocket(target, {
            headers: { origin: `${session.url.split('/preview/')[0]}` },
          })
          const queued: Array<{ data: Parameters<WebSocket['send']>[0]; binary: boolean }> = []
          client.on('message', (data, binary) => {
            if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
            else if (upstream.readyState === WebSocket.CONNECTING) queued.push({ data, binary })
          })
          upstream.on('open', () => {
            for (const item of queued) upstream.send(item.data, { binary: item.binary })
            queued.length = 0
          })
          upstream.on('message', (data, binary) => {
            if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
          })
          client.on('close', () => upstream.close())
          upstream.on('close', () => client.close())
          client.on('error', () => upstream.close())
          upstream.on('error', () => client.close(1011, '工作区连接失败'))
        })
      }
      vite.httpServer?.on('upgrade', handlePreviewUpgrade)
      vite.httpServer?.once('close', () => {
        vite.httpServer?.off('upgrade', handlePreviewUpgrade)
        previewProxyWss.close()
        for (const session of sessions.values()) session.close()
        void authPool.end()
      })
      const cleanupIdleSessions = () => {
        const now = Date.now()
        for (const [id, session] of sessions) {
          if (now - session.lastAccessAt <= IDLE_SESSION_MS) continue
          session.close()
          sessions.delete(id)
        }
      }
      const cleanupTimer = setInterval(cleanupIdleSessions, 60_000)
      cleanupTimer.unref?.()
      vite.httpServer?.once('close', () => clearInterval(cleanupTimer))
      vite.middlewares.use('/api/layrr', async (req, res) => {
        try {
          // No CORS, cookie authentication or arbitrary filesystem access.
          const origin = req.headers.origin
          if (
            req.headers['x-quickpage-layrr'] !== '1' ||
            (origin && new URL(origin).host !== req.headers.host) ||
            !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
          ) {
            json(res, { error: '仅允许本机小豆原型访问' }, 403)
            return
          }
          const parts = (req.url ?? '').split('?')[0]!.split('/').filter(Boolean)
          if (req.method === 'POST' && parts.length === 0) {
            cleanupIdleSessions()
            const input = await body(req)
            if (
              typeof input.html !== 'string' ||
              !input.html.trim() ||
              typeof input.projectId !== 'string' ||
              typeof input.pageId !== 'string' ||
              typeof input.baseline !== 'string'
            )
              throw new Error('缺少页面或版本信息')
            const actor = authorization.requireActor(await authorization.actorFromRequest(authPool, req))
            await authorization.resolveProjectAccess(authPool, actor, input.projectId, 'write')
            if (sessions.size >= 8) throw new Error('最多打开 8 个工作区，请先关闭其他工作区')
            const id = randomBytes(24).toString('hex')
            const folder = join(vite.config.root, '.quickpage-layrr', id)
            await mkdir(folder, { recursive: true })
            const file = join(folder, 'index.html')
            await writeFile(file, input.html, 'utf8')
            const overlay = join(require.resolve('layrr/package.json'), '..', 'dist', 'overlay.js')
            const prefix = `/preview/${id}`
            const overlaySource = adaptLayrrWorkspaceOverlay(await readFile(overlay, 'utf8')).replaceAll(
              '/__layrr__/fonts/',
              `${prefix}/__layrr__/fonts/`,
            )
            const sockets = new Set<WebSocket>()
            const server = createServer(async (previewReq, previewRes) => {
              const rawPath = (previewReq.url ?? '').split('?')[0]!
              const path = rawPath.startsWith('/__layrr__/fonts/') ? prefix + rawPath : rawPath
              if (path !== prefix && !path?.startsWith(`${prefix}/`)) {
                previewRes.writeHead(404).end()
                return
              }
              previewRes.setHeader('Cache-Control', 'no-store')
              previewRes.setHeader('Referrer-Policy', 'no-referrer')
              previewRes.setHeader('X-Content-Type-Options', 'nosniff')
              try {
                if (path === `${prefix}/grid`) {
                  previewRes.setHeader('Content-Type', 'text/html; charset=utf-8')
                  previewRes.end(gridstackEditorShell(prefix))
                  return
                }
                const assets: Record<string, [string, string]> = {
                  'gridstack.js': [
                    require.resolve('gridstack/dist/gridstack-all.js'),
                    'text/javascript',
                  ],
                  'gridstack.css': [
                    require.resolve('gridstack/dist/gridstack.min.css'),
                    'text/css',
                  ],
                  'gridstack-client.js': [
                    fileURLToPath(new URL('./gridstackClient.js', import.meta.url)),
                    'text/javascript',
                  ],
                  'gridstack-document.js': [
                    fileURLToPath(new URL('./gridstackDocument.js', import.meta.url)),
                    'text/javascript',
                  ],
                  'manual-history.js': [
                    fileURLToPath(new URL('./layrrManualHistory.js', import.meta.url)),
                    'text/javascript',
                  ],
                }
                const asset = path.startsWith(`${prefix}/__layrr__/`)
                  ? assets[path.slice(`${prefix}/__layrr__/`.length)]
                  : undefined
                if (asset) {
                  previewRes.setHeader('Content-Type', asset[1] + '; charset=utf-8')
                  previewRes.end(await readFile(asset[0]))
                  return
                }
                if (path === `${prefix}/manual`) {
                  previewRes.setHeader('Content-Type', 'text/html; charset=utf-8')
                  previewRes.end(manualEditorShell(prefix))
                  return
                }
                if (path === `${prefix}/__layrr__/manual.js`) {
                  previewRes.setHeader('Content-Type', 'text/javascript; charset=utf-8')
                  previewRes.end(await readFile(new URL('./layrrManualClient.js', import.meta.url)))
                  return
                }
                if (path === `${prefix}/__layrr__/interact.js`) {
                  previewRes.setHeader('Content-Type', 'text/javascript; charset=utf-8')
                  previewRes.end(await readFile(require.resolve('interactjs')))
                  return
                }
                if (path === `${prefix}/__layrr__/manual-layout.js`) {
                  previewRes.setHeader('Content-Type', 'text/javascript; charset=utf-8')
                  previewRes.end(await readFile(new URL('./layrrManualLayout.js', import.meta.url)))
                  return
                }
                if (path === `${prefix}/__layrr__/manual-text.js`) {
                  previewRes.setHeader('Content-Type', 'text/javascript; charset=utf-8')
                  previewRes.end(await readFile(new URL('./layrrManualText.js', import.meta.url)))
                  return
                }
                if (path === `${prefix}/__layrr__/manual-image.js`) {
                  previewRes.setHeader('Content-Type', 'text/javascript; charset=utf-8')
                  previewRes.end(await readFile(new URL('./layrrManualImage.js', import.meta.url)))
                  return
                }
                if (
                  path === `${prefix}/__layrr__/manual-data`
                ) {
                  const session = sessions.get(id)
                  if (!session) {
                    json(previewRes, { error: '工作区已关闭' }, 404)
                    return
                  }
                  const origin = previewReq.headers.origin
                  if (
                    previewReq.headers['x-quickpage-manual'] !== '1' ||
                    (origin && new URL(origin).host !== previewReq.headers.host)
                  ) {
                    json(previewRes, { error: '仅允许当前工作区访问' }, 403)
                    return
                  }
                  if (previewReq.method === 'GET') {
                    const html = await readFile(file, 'utf8')
                    const submissionId = new URL(previewReq.url!, 'http://localhost').searchParams.get('submission')
                    json(previewRes, {
                      html, revision: htmlRevision(html), pendingSubmissionId: session.submission?.id,
                      submissionStatus: submissionId ? session.submissionResults.get(submissionId) : undefined,
                    })
                    return
                  }
                  if (previewReq.method !== 'POST') {
                    json(previewRes, { error: 'Method not allowed' }, 405)
                    return
                  }
                  try {
                    json(previewRes, await saveDocument(session, await body(previewReq)))
                  } catch (error) {
                    json(
                      previewRes,
                      { error: error instanceof Error ? error.message : '手动保存失败' },
                      409,
                    )
                  }
                  return
                }
                if (path === `${prefix}/__layrr__/overlay.js`) {
                  previewRes.setHeader('Content-Type', 'text/javascript')
                  previewRes.end(overlaySource)
                  return
                }
                if (path === `${prefix}/__layrr__/history`) {
                  json(previewRes, { commits: [], currentHash: '' })
                  return
                }
                if (path === `${prefix}/__layrr__/edit-status`) {
                  json(previewRes, sessions.get(id)?.lastResult ?? { success: null })
                  return
                }
                if (path?.includes('/__layrr__/fonts/')) {
                  const name = path.split('/').at(-1)!
                  if (!/^[a-zA-Z0-9_.-]+\.(css|woff2?|ttf)$/.test(name))
                    throw new Error('Invalid font')
                  previewRes.setHeader(
                    'Content-Type',
                    name.endsWith('.css') ? 'text/css' : 'font/woff2',
                  )
                  previewRes.end(await readFile(join(overlay, '..', 'fonts', name)))
                  return
                }
                if (path !== prefix && path !== `${prefix}/` && path !== `${prefix}/index.html`) {
                  previewRes.writeHead(404).end()
                  return
                }
                let html = prepareLayrrPreviewHtml(await readFile(file, 'utf8'))
                const script = `<script src="${prefix}/__layrr__/overlay.js"></script>`
                html = /<\/body>/i.test(html)
                  ? html.replace(/<\/body>/i, `${script}</body>`)
                  : html + script
                previewRes.setHeader('Content-Type', 'text/html; charset=utf-8')
                previewRes.setHeader(
                  'Content-Security-Policy',
                  "default-src 'self' data: blob: https: http:; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http:; style-src 'self' 'unsafe-inline' data: https: http:; img-src * data: blob:; font-src * data:; connect-src * ws: wss:; frame-src * data: blob:",
                )
                previewRes.end(html)
              } catch {
                previewRes.writeHead(500).end('工作区读取失败')
              }
            })
            const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
            server.on('upgrade', (request, socket, head) => {
              const originHost = request.headers.origin ? new URL(request.headers.origin).host : ''
              if (request.url !== `${prefix}/__layrr__/ws` || originHost !== request.headers.host) {
                socket.destroy()
                return
              }
              wss.handleUpgrade(request, socket, head, (ws) => {
                sockets.add(ws)
                ws.on('close', () => sockets.delete(ws))
                ws.on('message', (raw) => {
                  const session = sessions.get(id)
                  if (!session) return
                  try {
                    const edit = JSON.parse(raw.toString()) as Edit & { type: string }
                    if (edit.type !== 'edit-request') return
                    if (session.job || session.writing || session.submission) throw new Error('已有修改进行中，请稍候')
                    if (
                      typeof edit.instruction !== 'string' ||
                      !edit.instruction.trim() ||
                      edit.instruction.length > 10000 ||
                      typeof edit.selector !== 'string'
                    )
                      throw new Error('无效修改请求')
                    edit.instruction = edit.instruction.trim()
                    edit.attachments = validateEditAttachments(edit.attachments)
                    session.job = { id: randomBytes(12).toString('hex'), edit, delivered: false }
                    session.lastResult = null
                  } catch (error) {
                    ws.send(
                      JSON.stringify({
                        type: 'edit-result',
                        success: false,
                        message: error instanceof Error ? error.message : '无效请求',
                      }),
                    )
                  }
                })
              })
            })
            await new Promise<void>((resolve, reject) => {
              server.once('error', reject)
              server.listen(0, '127.0.0.1', resolve)
            })
            const address = server.address()
            if (!address || typeof address === 'string') throw new Error('无法启动工作区')
            const url = `http://127.0.0.1:${address.port}${prefix}/`
            sessions.set(id, {
              file,
              url,
              projectId: input.projectId,
              pageId: input.pageId,
              baseline: input.baseline,
              writing: false,
              submission: null,
              submissionResults: new Map(),
              job: null,
              lastResult: null,
              sockets,
              lastAccessAt: Date.now(),
              close: () => {
                for (const ws of sockets) ws.terminate()
                wss.close()
                server.close()
                server.closeAllConnections()
              },
            })
            const publicUrl = `${prefix}/`
            json(res, { id, url: publicUrl, file, editorUrl: publicUrl + 'manual' })
            return
          }
          const session = sessions.get(parts[0] ?? '')
          if (!session) {
            json(res, { error: '工作区已关闭，请重新打开' }, 404)
            return
          }
          session.lastAccessAt = Date.now()
          if (parts[1] === 'document') {
            if (req.method === 'GET') {
              const html = await readFile(session.file, 'utf8')
              const submissionId = new URL(req.url!, 'http://localhost').searchParams.get('submission')
              json(res, {
                html, revision: htmlRevision(html), pendingSubmissionId: session.submission?.id,
                submissionStatus: submissionId ? session.submissionResults.get(submissionId) : undefined,
              })
              return
            }
            if (req.method === 'POST') {
              try {
                json(res, await saveDocument(session, await body(req)))
              } catch (error) {
                json(res, { error: error instanceof Error ? error.message : '保存失败' }, 409)
              }
              return
            }
            json(res, { error: 'Method not allowed' }, 405)
            return
          }
          if (req.method === 'DELETE') {
            session.close()
            sessions.delete(parts[0]!)
            json(res, { ok: true })
            return
          }
          if (req.method === 'GET') {
            const job = session.job && !session.job.delivered ? session.job : null
            if (job) job.delivered = true
            json(res, { html: await readFile(session.file, 'utf8'), job, submission: session.submission })
            return
          }
          if (req.method === 'POST') {
            const input = await body(req)
            if (typeof input.submissionId === 'string') {
              if (session.submissionResults.has(input.submissionId)) {
                json(res, { ok: true })
                return
              }
              if (!session.submission || session.submission.id !== input.submissionId)
                throw new Error('提交已失效，请重新提交')
              const result = {
                id: session.submission.id,
                success: input.success === true,
                message: String(input.message ?? '版本保存完成').slice(0, 500),
                revision: htmlRevision(session.submission.html),
                feedbackText: session.submission.feedbackText,
              }
              if (session.submission.source === 'ai-local') {
                if (!result.success && session.submission.originalHtml !== undefined)
                  await writeFile(session.file, session.submission.originalHtml, 'utf8')
                session.lastResult = { success: result.success, message: result.message, timestamp: Date.now() }
                for (const ws of session.sockets)
                  if (ws.readyState === WebSocket.OPEN)
                    ws.send(JSON.stringify({ type: 'edit-result', ...session.lastResult }))
              }
              session.submissionResults.set(result.id, result)
              if (session.submissionResults.size > 20)
                session.submissionResults.delete(session.submissionResults.keys().next().value!)
              session.submission = null
              json(res, { ok: true })
              return
            }
            if (!session.job || input.jobId !== session.job.id) throw new Error('修改请求已失效')
            if (input.success === true) {
              if (typeof input.html !== 'string' || !input.html.trim())
                throw new Error('修改内容为空')
              const originalHtml = await readFile(session.file, 'utf8')
              await writeFile(session.file, input.html, 'utf8')
              session.submission = {
                id: session.job.id,
                html: input.html,
                feedbackText: session.job.edit.instruction.trim().slice(0, 500),
                source: 'ai-local',
                originalHtml,
              }
              session.job = null
              json(res, { ok: true, submission: session.submission })
              return
            }
            session.lastResult = {
              success: input.success === true,
              message:
                input.success === true
                  ? '局部修改完成，正在自动保存到页面历史'
                  : String(input.message ?? '修改失败').slice(0, 500),
              timestamp: Date.now(),
            }
            session.job = null
            for (const ws of session.sockets)
              if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'edit-result', ...session.lastResult }))
            json(res, { ok: true })
            return
          }
          json(res, { error: 'Method not allowed' }, 405)
        } catch (error) {
          json(res, { error: error instanceof Error ? error.message : 'Layrr 工作区错误' }, 400)
        }
      })
  }
  return {
    name: 'quickpage-layrr-bridge',
    configureServer: configure,
    configurePreviewServer: configure,
  }
}
