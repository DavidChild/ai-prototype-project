import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createJiti } from 'jiti'

// Use an installed Playwright or an explicit external runtime; no production dependency.
let playwright
try {
  playwright = await import(process.env.QUICKPAGE_PLAYWRIGHT_PATH || 'playwright')
} catch (error) {
  if (process.env.QUICKPAGE_PLAYWRIGHT_PATH) throw error
}

test('manual editing and undo/redo preserve the iframe document and source changes', {
  skip: !playwright && 'Set QUICKPAGE_PLAYWRIGHT_PATH or install Playwright to run browser regression tests',
}, async (t) => {
  const { layrrBridgePlugin } = await createJiti(import.meta.url).import('../server/layrrBridge.ts')
  const root = await mkdtemp(join(tmpdir(), 'quickpage-manual-browser-'))
  let handle
  const server = createServer((req, res) => {
    req.url = req.url.slice('/api/layrr'.length)
    void handle(req, res)
  })
  layrrBridgePlugin().configureServer({
    config: { root }, httpServer: server,
    middlewares: { use(_path, callback) { handle = callback } },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const headers = { 'x-quickpage-layrr': '1', 'Content-Type': 'application/json', Origin: origin }
  let browser, session
  t.after(async () => {
    await browser?.close()
    if (session) await fetch(origin + '/api/layrr/' + session.id, { method: 'DELETE', headers })
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const html = `<!doctype html><html><head><style>
    body{margin:40px;min-height:2000px}#box{width:180px;height:90px;background:#ddd}
    #firstLink{display:block;width:180px;height:40px;margin-bottom:30px}
    #target{width:300px;min-height:80px;border:1px solid gray;margin-top:30px}
    </style></head><body><a id="firstLink" href="manual" onclick="parent.prototypeClicks=(parent.prototypeClicks||0)+1">First drag link</a>
    <div id="box">Original text</div><section id="target">Target</section>
    <svg id="icon" width="40" height="40"><title>Logo</title><circle r="10" cx="20" cy="20"/></svg>
    <script>parent.prototypeBoots=(parent.prototypeBoots||0)+1;
    window.runtimeState={value:123};document.body.dataset.runtime='retained';
    const link=document.getElementById('firstLink');
    link.addEventListener('pointerup',()=>link.click(),{once:true});</script></body></html>`
  session = await fetch(origin + '/api/layrr', {
    method: 'POST', headers, body: JSON.stringify({ html, projectId: 'test', pageId: 'test', baseline: 'test' }),
  }).then((res) => res.json())
  assert.ok(session.url, JSON.stringify(session))
  browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.QUICKPAGE_BROWSER_CHANNEL ? { channel: process.env.QUICKPAGE_BROWSER_CHANNEL } : {}),
  })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(session.url + 'manual')
  await page.waitForFunction(() => document.querySelector('#dirty').textContent === '工作区已同步')
  await page.evaluate(() => {
    window.originalCanvasDocument = document.querySelector('#canvas').contentDocument
    window.originalBox = window.originalCanvasDocument.querySelector('#box')
    window.canvasLoads = 0
    document.querySelector('#canvas').addEventListener('load', () => window.canvasLoads++)
  })
  const canvas = page.frameLocator('#canvas')
  const box = canvas.locator('#box')
  async function checkStable() {
    assert.deepEqual(await page.evaluate(() => ({
      sameDocument: originalCanvasDocument === document.querySelector('#canvas').contentDocument,
      sameBox: originalBox === document.querySelector('#canvas').contentDocument.querySelector('#box'),
      boots: prototypeBoots, loads: canvasLoads,
      runtime: document.querySelector('#canvas').contentWindow.runtimeState.value,
      runtimeAttribute: document.querySelector('#canvas').contentDocument.body.dataset.runtime,
    })), { sameDocument: true, sameBox: true, boots: 1, loads: 0, runtime: 123, runtimeAttribute: 'retained' })
    assert.deepEqual(errors, [])
  }
  async function drag(locator, dx, dy) {
    const rect = await locator.boundingBox()
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y + dy, { steps: 8 })
    await page.mouse.up()
  }
  async function undo() { await page.locator('#undo').click(); await checkStable() }
  async function redo() { await page.locator('#redo').click(); await checkStable() }
  // Drag without preselecting. Some prototypes activate links from pointerup;
  // ignored clicks must still prevent navigation and business click handlers.
  await drag(canvas.locator('#firstLink'), 25, 15)
  await checkStable()
  assert.equal(await page.evaluate(() => window.prototypeClicks || 0), 0)
  await undo()
  await redo()
  await box.click()
  await drag(canvas.locator('#qp-manual-highlight [data-move]'), 45, 25)
  const first = await box.getAttribute('style')
  assert.match(first, /translate:/)
  await drag(canvas.locator('#qp-manual-highlight [data-move]'), 30, 15)
  const second = await box.getAttribute('style')
  assert.notEqual(first, second)
  await undo()
  assert.equal(await box.getAttribute('style'), first)
  await undo()
  assert.equal(await box.getAttribute('style'), null)
  await redo()
  await redo()
  assert.equal(await box.getAttribute('style'), second)

  await drag(canvas.locator('#qp-manual-highlight [data-corner="se"]'), 35, 20)
  const resized = await box.getAttribute('style')
  assert.match(resized, /width:/)
  await undo()
  assert.equal(await box.getAttribute('style'), second)
  await redo()
  assert.equal(await box.getAttribute('style'), resized)

  await drag(canvas.locator('#qp-manual-highlight [data-corner="nw"]'), -15, -10)
  const topLeftResized = await box.getAttribute('style')
  assert.notEqual(topLeftResized, resized)
  await undo()
  assert.equal(await box.getAttribute('style'), resized)
  await redo()
  assert.equal(await box.getAttribute('style'), topLeftResized)

  await page.locator('#text').fill('Edited text')
  await page.locator('#applyText').click()
  assert.equal(await box.textContent(), 'Edited text')
  await undo()
  assert.equal(await box.textContent(), 'Original text')
  await redo()
  assert.equal(await box.textContent(), 'Edited text')

  await page.locator('#duplicate').click()
  const copy = canvas.locator('#box + div')
  assert.equal(await copy.textContent(), 'Edited text')
  await page.locator('#delete').click()
  assert.equal(await copy.count(), 0)
  await undo()
  assert.equal(await copy.textContent(), 'Edited text')
  await undo()
  assert.equal(await copy.count(), 0)
  await redo()
  assert.equal(await copy.textContent(), 'Edited text')
  await redo()
  assert.equal(await copy.count(), 0)

  // SVG replacement is a structural edit too; preserve the old subtree on undo.
  await canvas.locator('#icon').click()
  await page.locator('#imageFile').setInputFiles({
    name: 'test.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9f8AAAAASUVORK5CYII=', 'base64'),
  })
  await canvas.locator('img#icon').waitFor()
  await undo()
  assert.equal(await canvas.locator('svg#icon circle').count(), 1)
  await redo()
  assert.equal(await canvas.locator('img#icon').count(), 1)

  await box.click()
  await page.locator('#dragMode').selectOption('reorder')
  const handleRect = await canvas.locator('#qp-manual-highlight [data-move]').boundingBox()
  const targetRect = await canvas.locator('#target').boundingBox()
  await page.mouse.move(handleRect.x + 10, handleRect.y + 10)
  await page.mouse.down()
  await page.mouse.move(targetRect.x + 100, targetRect.y + targetRect.height / 2, { steps: 10 })
  await page.mouse.up()
  assert.equal(await canvas.locator('#target > #box').count(), 1)
  await undo()
  assert.equal(await canvas.locator('body > #box').count(), 1)
  await redo()
  assert.equal(await canvas.locator('#target > #box').count(), 1)

  // New edits after undo must discard only the redo branch, not earlier changes.
  await undo()
  await page.locator('#width').fill('240px')
  await page.locator('#width').press('Tab')
  assert.equal(await page.locator('#redo').isDisabled(), true)
  await checkStable()
  // Keyboard shortcuts use the same incremental history while retaining scroll.
  await page.evaluate(() => {
    document.querySelector('#canvas').contentWindow.scrollTo(0, 250)
    document.querySelector('#undo').focus()
  })
  await page.keyboard.press('Control+z')
  assert.notEqual(await box.getAttribute('style'), null)
  assert.equal(await page.locator('#width').inputValue(), '230px')
  await page.keyboard.press('Control+Shift+z')
  assert.equal(await page.locator('#width').inputValue(), '240px')
  assert.equal(await page.evaluate(() => document.querySelector('#canvas').contentWindow.scrollY), 250)
  await checkStable()
  await page.locator('#save').click()
  await page.waitForFunction(() => document.querySelector('#dirty').textContent === '工作区已同步')
  const saved = await fetch(session.url + '__layrr__/manual-data', {
    headers: { 'x-quickpage-manual': '1' },
  }).then((res) => res.json())
  assert.match(saved.html, /Edited text/)
  assert.match(saved.html, /width: 240px/)
  assert.match(saved.html, /translate:/)
  assert.doesNotMatch(saved.html, /data-quickpage-manual-node|qp-manual-highlight|data-runtime/)
  await checkStable()
})
