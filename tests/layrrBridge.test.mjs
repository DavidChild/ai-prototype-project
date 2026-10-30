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
  let apiHandle
  let previewHandle
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/layrr')) {
      req.url = req.url.slice('/api/layrr'.length)
      void apiHandle(req, res)
      return
    }
    void previewHandle(req, res, () => res.writeHead(404).end())
  })
  layrrBridgePlugin(undefined, {
    actorFromRequest: async () => ({ userId: 'test', tenantId: 'test', tenantRole: 'tenant_admin' }),
    requireActor: (actor) => actor,
    resolveProjectAccess: async () => ({ tenantId: 'test', data: {} }),
  }).configureServer({
    config: { root },
    httpServer: server,
    middlewares: {
      use(path, callback) {
        if (typeof path === 'function') previewHandle = path
        else {
          assert.equal(path, '/api/layrr')
          apiHandle = callback
        }
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
  const initialHtml = `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self'"></head><body><h1>old</h1></body></html>`
  const session = (
    await request('', 'POST', {
      html: initialHtml,
      projectId: 'iteration',
      pageId: 'page',
      baseline: 'baseline',
      constraints: [{
        name: '标准按钮',
        description: '使用统一的主按钮结构',
        html: '<button class="primary">提交</button>',
        scope: 'global',
      }],
    })
  ).data
  assert.ok(session.id, JSON.stringify(session))
  assert.equal(session.editorUrl, session.url + 'manual')
  assert.equal(session.url, `/preview/${session.id}/`)
  assert.doesNotMatch(session.url, /127\.0\.0\.1|localhost/)
  const publicUrl = origin + session.url
  const initialPreviewResponse = await fetch(publicUrl)
  const initialPreview = await initialPreviewResponse.text()
  assert.doesNotMatch(initialPreview, /Content-Security-Policy/i)
  assert.match(initialPreview, /__layrr__\/overlay\.js/)
  assert.match(initialPreview, /__QP_LAYRR_CONSTRAINTS__/)
  assert.match(initialPreview, /标准按钮/)
  assert.match(initialPreview, /"scope":"global"/)
  assert.match(initialPreviewResponse.headers.get('content-security-policy'), /'unsafe-eval'/)
  assert.equal(await readFile(session.file, 'utf8'), initialHtml)
  const documentUrl = origin + '/api/layrr/' + session.id + '/document'
  const documentState = await fetch(documentUrl, { headers }).then((response) => response.json())
  assert.equal(documentState.html, initialHtml)
  const savedDocument = await fetch(documentUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ revision: documentState.revision, html: '<html><body><h1>edited</h1></body></html>' }),
  })
  assert.equal(savedDocument.status, 200)
  assert.equal((await request('/' + session.id)).data.html, '<html><body><h1>edited</h1></body></html>')
  const preview = await (await fetch(publicUrl)).text()
  assert.ok(preview.includes('__layrr__/overlay.js'))
  assert.doesNotMatch(await readFile(session.file, 'utf8'), /__layrr__/)
  const previewOrigin = origin
  const prefix = session.url.slice(0, -1)
  const overlayResponse = await fetch(previewOrigin + prefix + '/__layrr__/overlay.js')
  assert.equal(overlayResponse.status, 200)
  const servedOverlay = await overlayResponse.text()
  assert.match(servedOverlay, /__LAYRR_LOADED__/)
  assert.match(servedOverlay, /CSS\.escape\(className\)/)
  assert.match(servedOverlay, new RegExp(prefix + '/__layrr__/fonts/lucide\\.css'))
  assert.doesNotMatch(servedOverlay, /["']\/__layrr__\/fonts\//)
  const iconCss = await fetch(previewOrigin + prefix + '/__layrr__/fonts/lucide.css')
  assert.equal(iconCss.status, 200)
  assert.match(await iconCss.text(), /@font-face/)
  const iconFont = await fetch(previewOrigin + prefix + '/__layrr__/fonts/lucide.woff2')
  assert.equal(iconFont.status, 200)
  assert.ok((await iconFont.arrayBuffer()).byteLength > 1000)
  assert.equal((await fetch(previewOrigin + '/package.json')).status, 404)
  const manualUrl = publicUrl + '__layrr__/manual-data'
  const manualHeaders = {
    'x-quickpage-manual': '1',
    Origin: previewOrigin,
    'Content-Type': 'application/json',
  }
  assert.match(await (await fetch(origin + session.editorUrl)).text(), /<strong>手动编辑<\/strong>/)
  const manualScript = await (await fetch(publicUrl + '__layrr__/manual.js')).text()
  new Function(manualScript.replace(/^import .*$/gm, ''))
  assert.match(await (await fetch(publicUrl + 'grid')).text(), /GridStack/)
  for (const asset of [
    'gridstack.js',
    'gridstack.css',
    'gridstack-client.js',
    'gridstack-document.js',
    'manual-layout.js',
    'manual-history.js',
    'interact.js',
  ]) {
    const response = await fetch(publicUrl + '__layrr__/' + asset)
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
  const submitState = await fetch(manualUrl, { headers: manualHeaders }).then((response) => response.json())
  for (const feedbackText of [undefined, '', '   ', 'x'.repeat(501)]) {
    const invalid = await manualSave({ revision: submitState.revision, html: 'invalid note', submit: true, feedbackText })
    assert.equal(invalid.status, 409)
    assert.match((await invalid.json()).error, /版本修改备注/)
  }
  assert.equal(await readFile(session.file, 'utf8'), manualHtml)
  const submission = {
    revision: submitState.revision,
    html: '<html><body><h1>提交修改</h1></body></html>',
    submit: true,
    feedbackText: '  调整标题尺寸和间距  ',
    submissionId: 'manual-submission-000001',
  }
  const queued = await manualSave(submission).then((response) => response.json())
  assert.equal(queued.submissionId, submission.submissionId)
  const pending = (await request('/' + session.id)).data.submission
  assert.equal(pending.feedbackText, '调整标题尺寸和间距')
  assert.equal(pending.source, 'layrr')
  assert.equal(pending.html, submission.html)
  assert.equal((await manualSave(submission)).status, 200, 'a lost POST response can be retried safely')
  assert.equal((await manualSave({ ...submission, html: 'changed retry' })).status, 409)
  assert.equal((await manualSave({ revision: queued.revision, html: 'another write' })).status, 409)
  const acknowledgment = { submissionId: pending.id, success: true, message: '已保存为 v2' }
  assert.equal((await request('/' + session.id, 'POST', acknowledgment)).status, 200)
  assert.equal((await request('/' + session.id, 'POST', acknowledgment)).status, 200)
  assert.equal((await request('/' + session.id)).data.submission, null)
  const receipt = await fetch(manualUrl + '?submission=' + pending.id, { headers: manualHeaders }).then((response) => response.json())
  assert.equal(receipt.submissionStatus.success, true)
  assert.equal(receipt.submissionStatus.message, '已保存为 v2')
  assert.equal((await manualSave(submission)).status, 200, 'a completed submission is not queued again')
  assert.equal((await request('/' + session.id)).data.submission, null)
  assert.equal((await manualSave({ ...submission, feedbackText: 'different note' })).status, 409)
  const next = {
    revision: queued.revision, html: '<p>继续编辑</p>', submit: true,
    feedbackText: '继续调整', submissionId: 'manual-submission-000002',
  }
  assert.equal((await request('/' + session.id + '/document', 'POST', next)).status, 200)
  const secondPending = (await request('/' + session.id)).data.submission
  assert.equal(secondPending.feedbackText, '继续调整')
  await request('/' + session.id, 'POST', { submissionId: secondPending.id, success: false, message: '页面已产生新版本' })
  const failedReceipt = await fetch(manualUrl + '?submission=' + secondPending.id, { headers: manualHeaders }).then((response) => response.json())
  assert.equal(failedReceipt.submissionStatus.success, false)
  assert.equal(failedReceipt.submissionStatus.message, '页面已产生新版本')
  assert.equal((await manualSave(submission)).status, 200)
  assert.equal(await readFile(session.file, 'utf8'), next.html, 'replaying an older submission must not overwrite later edits')
  const ws = new WebSocket(previewOrigin.replace('http:', 'ws:') + prefix + '/__layrr__/ws', {
    origin: previewOrigin,
  })
  await once(ws, 'open')
  t.after(() => ws.terminate())
  const selectedConstraint = {
    name: '标准按钮',
    description: '使用统一的主按钮结构',
    html: '<button class="primary">提交</button>',
  }
  ws.send(JSON.stringify({
    type: 'edit-request', selector: 'h1', instruction: 'change text', constraint: selectedConstraint,
  }))
  await new Promise((resolve) => setTimeout(resolve, 30))
  const job = (await request('/' + session.id)).data.job
  assert.equal(job.edit.selector, 'h1')
  assert.deepEqual(job.edit.constraint, selectedConstraint)
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
  assert.match((await request('/' + session.id)).data.html, /new/)
  const aiSubmission = (await request('/' + session.id)).data.submission
  assert.equal(aiSubmission.id, job.id)
  assert.equal(aiSubmission.feedbackText, 'change text')
  assert.equal(aiSubmission.source, 'ai-local')
  assert.equal((await fetch(publicUrl + '__layrr__/edit-status').then((response) => response.json())).success, null)
  await request('/' + session.id, 'POST', { submissionId: aiSubmission.id, success: true, message: '已保存为 v3' })
  assert.equal(JSON.parse((await resultPromise)[0]).success, true)
  assert.equal(
    (await request('/' + session.id, 'POST', { jobId: job.id, success: true, html: 'stale' }))
      .status,
    400,
  )
  await request('/' + session.id, 'DELETE')
  assert.equal((await request('/' + session.id)).status, 404)
})
