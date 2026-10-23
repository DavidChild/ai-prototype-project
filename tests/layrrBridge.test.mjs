import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import { createJiti } from 'jiti'
const jiti = createJiti(import.meta.url)
const { layrrBridgePlugin } = await jiti.import('../server/layrrBridge.ts')

test('Layrr workspaces serve official overlay, accept local jobs and isolate files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'quickpage-layrr-test-'))
  let handle
  const server = createServer((req, res) => {
    req.url = req.url.slice('/api/layrr'.length)
    void handle(req, res)
  })
  layrrBridgePlugin().configureServer({
    config: { root },
    httpServer: server,
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/layrr')
        handle = callback
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const headers = { 'x-quickpage-layrr': '1', 'Content-Type': 'application/json', Origin: origin }
  const request = async (path, method = 'GET', data) => {
    const response = await fetch(origin + '/api/layrr' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    })
    return { status: response.status, data: await response.json() }
  }
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const forbidden = await fetch(origin + '/api/layrr', {
    method: 'POST',
    headers: { ...headers, Origin: 'https://evil.example' },
    body: '{}',
  })
  assert.equal(forbidden.status, 403)
  const session = (
    await request('', 'POST', {
      html: '<html><body><h1>old</h1></body></html>',
      projectId: 'iteration',
      pageId: 'page',
      baseline: 'baseline',
    })
  ).data
  assert.ok(session.id)
  assert.match(session.editorUrl, /tmagic-editor\.html\?workspace=/)
  const documentUrl = origin + '/api/layrr/' + session.id + '/document'
  const documentState = await fetch(documentUrl, { headers }).then((response) => response.json())
  assert.equal(documentState.html, '<html><body><h1>old</h1></body></html>')
  const savedDocument = await fetch(documentUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ revision: documentState.revision, html: '<html><body><h1>edited</h1></body></html>' }),
  })
  assert.equal(savedDocument.status, 200)
  assert.equal((await request('/' + session.id)).data.html, '<html><body><h1>edited</h1></body></html>')
  const preview = await (await fetch(session.url)).text()
  assert.ok(preview.includes('__layrr__/overlay.js'))
  assert.doesNotMatch(await readFile(session.file, 'utf8'), /__layrr__/)
  const previewOrigin = new URL(session.url).origin
  const prefix = new URL(session.url).pathname.slice(0, -1)
  const overlayResponse = await fetch(previewOrigin + prefix + '/__layrr__/overlay.js')
  assert.equal(overlayResponse.status, 200)
  const servedOverlay = await overlayResponse.text()
  assert.match(servedOverlay, /__LAYRR_LOADED__/)
  assert.match(servedOverlay, /CSS\.escape\(className\)/)
  assert.equal((await fetch(previewOrigin + '/package.json')).status, 404)
  const manualUrl = session.url + '__layrr__/manual-data'
  const manualHeaders = {
    'x-quickpage-manual': '1',
    Origin: previewOrigin,
    'Content-Type': 'application/json',
  }
  assert.match(await (await fetch(session.url + 'manual')).text(), /不调用 AI/)
  const manualScript = await (await fetch(session.url + '__layrr__/manual.js')).text()
  new Function(manualScript.replace(/^import .*$/gm, ''))
  assert.match(await (await fetch(session.url + 'grid')).text(), /GridStack/)
  for (const asset of [
    'gridstack.js',
    'gridstack.css',
    'gridstack-client.js',
    'gridstack-document.js',
    'manual-layout.js',
    'manual-history.js',
    'interact.js',
  ]) {
    const response = await fetch(session.url + '__layrr__/' + asset)
    assert.equal(response.status, 200, asset)
    assert.ok((await response.text()).length > 10, asset)
  }
  assert.equal((await fetch(manualUrl)).status, 403)
  assert.equal(
    (await fetch(manualUrl, { headers: { ...manualHeaders, Origin: 'https://evil.example' } }))
      .status,
    403,
  )
  const manualState = await (await fetch(manualUrl, { headers: manualHeaders })).json()
  const manualSave = (data) =>
    fetch(manualUrl, { method: 'POST', headers: manualHeaders, body: JSON.stringify(data) })
  const manualHtml = '<html><body><h1>手动文字</h1></body></html>'
  assert.equal((await manualSave({ revision: manualState.revision, html: manualHtml })).status, 200)
  assert.equal((await request('/' + session.id)).data.html, manualHtml)
  assert.equal((await request('/' + session.id)).data.job, null)
  assert.equal((await manualSave({ revision: manualState.revision, html: 'stale' })).status, 409)
  const ws = new WebSocket(previewOrigin.replace('http:', 'ws:') + prefix + '/__layrr__/ws', {
    origin: previewOrigin,
  })
  await once(ws, 'open')
  t.after(() => ws.terminate())
  ws.send(JSON.stringify({ type: 'edit-request', selector: 'h1', instruction: 'change text' }))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const job = (await request('/' + session.id)).data.job
  assert.equal(job.edit.selector, 'h1')
  const busyState = await (await fetch(manualUrl, { headers: manualHeaders })).json()
  assert.equal((await manualSave({ revision: busyState.revision, html: 'during AI' })).status, 409)
  assert.equal((await request('/' + session.id)).data.job, null)
  const resultPromise = once(ws, 'message')
  assert.equal(
    (
      await request('/' + session.id, 'POST', {
        jobId: job.id,
        success: true,
        html: '<html><body><h1>new</h1></body></html>',
      })
    ).status,
    200,
  )
  assert.equal(JSON.parse((await resultPromise)[0]).success, true)
  assert.match((await request('/' + session.id)).data.html, /new/)
  assert.equal(
    (await request('/' + session.id, 'POST', { jobId: job.id, success: true, html: 'stale' }))
      .status,
    400,
  )
  await request('/' + session.id, 'DELETE')
  assert.equal((await request('/' + session.id)).status, 404)
})
