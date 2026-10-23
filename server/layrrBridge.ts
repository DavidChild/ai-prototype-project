import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import type { Plugin } from 'vite'
import { adaptLayrrOverlay } from './layrrOverlay'
import { htmlRevision, manualEditorShell, validateManualSave } from './layrrManual'
import { gridstackEditorShell } from './gridstackEditor'

const require = createRequire(import.meta.url)
const LIMIT = 5 * 1024 * 1024
type Edit = { instruction: string; selector: string; elements?: { selector: string }[] }
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

/** Uses the official Layrr overlay, with a QuickPage provider/patch adapter instead of a CLI agent. */
export function layrrBridgePlugin(): Plugin {
  return {
    name: 'quickpage-layrr-bridge',
    configureServer(vite) {
      const sessions = new Map<
        string,
        {
          file: string
          url: string
          projectId: string
          pageId: string
          baseline: string
          writing: boolean
          job: { id: string; edit: Edit; delivered: boolean } | null
          lastResult: { success: boolean; message: string; timestamp: number } | null
          sockets: Set<WebSocket>
          close: () => void
        }
      >()
      vite.httpServer?.once('close', () => {
        for (const session of sessions.values()) session.close()
      })
      vite.middlewares.use('/api/layrr', async (req, res) => {
        try {
          // No CORS, cookie authentication or arbitrary filesystem access.
          const origin = req.headers.origin
          if (
            req.headers['x-quickpage-layrr'] !== '1' ||
            (origin && new URL(origin).host !== req.headers.host) ||
            !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
          ) {
            json(res, { error: '仅允许本机 QuickPage 访问' }, 403)
            return
          }
          const parts = (req.url ?? '').split('?')[0]!.split('/').filter(Boolean)
          if (req.method === 'POST' && parts.length === 0) {
            const input = await body(req)
            if (
              typeof input.html !== 'string' ||
              !input.html.trim() ||
              typeof input.projectId !== 'string' ||
              typeof input.pageId !== 'string' ||
              typeof input.baseline !== 'string'
            )
              throw new Error('缺少页面或版本信息')
            if (sessions.size >= 8) throw new Error('最多打开 8 个工作区，请先关闭其他工作区')
            const id = randomBytes(24).toString('hex')
            const folder = join(vite.config.root, '.quickpage-layrr', id)
            await mkdir(folder, { recursive: true })
            const file = join(folder, 'index.html')
            await writeFile(file, input.html, 'utf8')
            const overlay = join(require.resolve('layrr/package.json'), '..', 'dist', 'overlay.js')
            const overlaySource = adaptLayrrOverlay(await readFile(overlay, 'utf8'))
            const prefix = `/preview/${id}`
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
                    json(previewRes, { html, revision: htmlRevision(html) })
                    return
                  }
                  if (previewReq.method !== 'POST') {
                    json(previewRes, { error: 'Method not allowed' }, 405)
                    return
                  }
                  if (session.writing || session.job) {
                    json(previewRes, { error: '已有修改进行中，请稍候或重新载入' }, 409)
                    return
                  }
                  session.writing = true
                  try {
                    const input = await body(previewReq)
                    const current = await readFile(file, 'utf8')
                    const html = validateManualSave(input, current, Boolean(session.job))
                    await writeFile(file, html, 'utf8')
                    json(previewRes, { ok: true, revision: htmlRevision(html) })
                  } catch (error) {
                    json(
                      previewRes,
                      { error: error instanceof Error ? error.message : '手动保存失败' },
                      409,
                    )
                  } finally {
                    session.writing = false
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
                let html = await readFile(file, 'utf8')
                const script = `<script src="${prefix}/__layrr__/overlay.js"></script>`
                html = /<\/body>/i.test(html)
                  ? html.replace(/<\/body>/i, `${script}</body>`)
                  : html + script
                previewRes.setHeader('Content-Type', 'text/html; charset=utf-8')
                previewRes.end(html)
              } catch {
                previewRes.writeHead(500).end('工作区读取失败')
              }
            })
            const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
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
                    if (session.job || session.writing) throw new Error('已有修改进行中，请稍候')
                    if (
                      typeof edit.instruction !== 'string' ||
                      !edit.instruction.trim() ||
                      edit.instruction.length > 10000 ||
                      typeof edit.selector !== 'string'
                    )
                      throw new Error('无效修改请求')
                    session.job = { id: randomBytes(12).toString('hex'), edit, delivered: false }
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
              job: null,
              lastResult: null,
              sockets,
              close: () => {
                for (const ws of sockets) ws.terminate()
                wss.close()
                server.close()
                server.closeAllConnections()
              },
            })
            const editorOrigin = typeof origin === 'string' ? origin : `http://${req.headers.host}`
            json(res, { id, url, file, editorUrl: `${editorOrigin}/tmagic-editor.html?workspace=${id}` })
            return
          }
          const session = sessions.get(parts[0] ?? '')
          if (!session) {
            json(res, { error: '工作区已关闭，请重新打开' }, 404)
            return
          }
          if (parts[1] === 'document') {
            if (req.method === 'GET') {
              const html = await readFile(session.file, 'utf8')
              json(res, { html, revision: htmlRevision(html) })
              return
            }
            if (req.method === 'POST') {
              if (session.writing || session.job) {
                json(res, { error: '已有修改进行中，请稍候' }, 409)
                return
              }
              session.writing = true
              try {
                const input = await body(req)
                const current = await readFile(session.file, 'utf8')
                const html = validateManualSave(input, current, Boolean(session.job))
                await writeFile(session.file, html, 'utf8')
                json(res, { ok: true, revision: htmlRevision(html) })
              } finally {
                session.writing = false
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
            json(res, { html: await readFile(session.file, 'utf8'), job })
            return
          }
          if (req.method === 'POST') {
            const input = await body(req)
            if (!session.job || input.jobId !== session.job.id) throw new Error('修改请求已失效')
            if (input.success === true) {
              if (typeof input.html !== 'string' || !input.html.trim())
                throw new Error('修改内容为空')
              await writeFile(session.file, input.html, 'utf8')
            }
            session.lastResult = {
              success: input.success === true,
              message:
                input.success === true
                  ? '局部修改完成，请返回 QuickPage 确认保存'
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
    },
  }
}
