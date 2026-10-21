import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadConfigFromFile } from 'vite'

const { config } = await loadConfigFromFile(
  { command: 'serve', mode: 'test' },
  fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
)
const plugin = config.plugins.flat(Infinity).find((item) => item?.name === 'qp-llm-proxy')

async function setup(t, respond, preview = false) {
  let handle
  const hook = preview ? plugin.configurePreviewServer : plugin.configureServer
  hook({
    middlewares: {
      use(path, middleware) {
        assert.equal(path, '/llm-proxy')
        handle = middleware
      },
    },
  })

  const upstream = createServer((req, res) => {
    Promise.resolve(respond(req, res)).catch((error) => res.destroy(error))
  })
  const proxy = createServer((req, res) => {
    req.url = req.url.slice('/llm-proxy'.length)
    void handle(req, res)
  })
  t.after(async () => {
    await Promise.all(
      [proxy, upstream].map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve)
            server.closeAllConnections()
          }),
      ),
    )
  })
  await Promise.all(
    [upstream, proxy].map(
      (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    ),
  )

  return (path, init = {}) =>
    fetch(`http://127.0.0.1:${proxy.address().port}/llm-proxy${path}`, {
      ...init,
      headers: {
        'x-qp-target': `http://127.0.0.1:${upstream.address().port}`,
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(3000),
    })
}

test('model listing still works', { timeout: 5000 }, async (t) => {
  const request = await setup(t, (req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/v1/models')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'local-test-model' }] }))
  })
  const response = await request('/v1/models')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { data: [{ id: 'local-test-model' }] })
})

for (const preview of [false, true]) {
  test(
    `POST body completion does not cancel ${preview ? 'preview' : 'dev'} requests`,
    { timeout: 5000 },
    async (t) => {
      const body = JSON.stringify({ model: 'local-test-model', messages: [], stream: true })
      const request = await setup(
        t,
        async (req, res) => {
          assert.equal(req.method, 'POST')
          assert.equal(req.url, '/v1/chat/completions')
          assert.equal(req.headers.authorization, 'Bearer local-test-key')
          assert.equal(req.headers['x-qp-target'], undefined)
          let received = ''
          for await (const chunk of req) received += chunk
          assert.equal(received, body)
          await delay(30)
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
        },
        preview,
      )
      const response = await request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local-test-key' },
        body,
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
    },
  )
}

test('SSE chunks arrive before the upstream response finishes', { timeout: 5000 }, async (t) => {
  let finishStream
  const canFinish = new Promise((resolve) => {
    finishStream = resolve
  })
  t.after(() => finishStream())
  const first = 'data: {"delta":"hello"}\n\n'
  const last = 'data: [DONE]\n\n'
  const request = await setup(t, async (req, res) => {
    for await (const _ of req) {
      /* consume the POST body */
    }
    res.setHeader('content-type', 'text/event-stream')
    res.write(first)
    await canFinish
    res.end(last)
  })
  const response = await request('/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader()
  const chunk = await reader.read()
  assert.equal(new TextDecoder().decode(chunk.value), first)
  finishStream()
  let remaining = ''
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    remaining += new TextDecoder().decode(next.value)
  }
  assert.equal(remaining, last)
})

test('client cancellation closes the upstream stream', { timeout: 5000 }, async (t) => {
  let closed
  const request = await setup(t, async (req, res) => {
    for await (const _ of req) {
      /* consume the POST body */
    }
    closed = once(res, 'close', { signal: AbortSignal.timeout(2000) })
    res.setHeader('content-type', 'text/event-stream')
    res.write('data: {"delta":"hello"}\n\n')
  })
  const abort = new AbortController()
  const response = await request('/v1/chat/completions', {
    method: 'POST',
    body: '{}',
    signal: abort.signal,
  })
  const reader = response.body.getReader()
  assert.equal((await reader.read()).done, false)
  abort.abort()
  await assert.rejects(reader.read(), { name: 'AbortError' })
  await closed
})

test('upstream errors preserve the HTTP status and error body', { timeout: 5000 }, async (t) => {
  const request = await setup(t, async (req, res) => {
    for await (const _ of req) {
      /* consume the POST body */
    }
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: { message: 'Invalid local test key' } }))
  })
  const response = await request('/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: { message: 'Invalid local test key' } })
})
