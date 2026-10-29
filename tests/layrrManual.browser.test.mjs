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
    config: { root }, httpServer: server,
    middlewares: {
      use(path, callback) {
        if (typeof path === 'function') previewHandle = path
        else apiHandle = callback
      },
    },
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
    #gridParent{display:flex;gap:20px;width:300px;height:180px;margin-top:30px}
    #gridItem{width:80px;height:40px;background:#ddd;flex:none}
    #siblings{display:grid;grid-template-columns:repeat(3,50px);grid-template-rows:repeat(3,40px);gap:10px;width:170px;margin-top:30px}
    #siblings>div{background:#eee;font-size:12px;line-height:16px;overflow:hidden}
    #swapRow{display:flex;gap:12px;width:310px;margin-top:30px;transform:scale(.85);transform-origin:top left}
    #swapRow>div{width:60px;height:40px;flex:none;background:#ddd}
    #swapRowB{translate:3px 0;transform:rotate(3deg)}
    #swapColumn{display:flex;flex-direction:column;gap:10px;margin-top:30px}
    #swapColumn>div{width:80px;height:30px;background:#ddd}
    #swapInline{margin-top:30px}
    #layoutChildren{width:360px;height:120px;margin-top:30px;padding:10px 20px;border:1px solid #bbb}
    #layoutChildren>span{display:block;width:40px;height:24px;background:#dbeafe}
    #multiRowChildren{display:grid;grid-template-columns:repeat(3,50px);grid-template-rows:repeat(2,30px);gap:12px 20px;width:300px;padding:10px;margin-top:30px;border:1px solid #bbb}
    #multiRowChildren>span{display:block;width:40px;height:20px;background:#dcfce7}
    #wrappedRows{width:300px;padding:10px;margin-top:30px;border:1px solid #bbb}#wrappedRows ul{display:flex;width:100%;padding:0;margin:0 0 12px;list-style:none}#wrappedRows li{width:40px;height:20px;background:#fef3c7}
    </style></head><body><a id="firstLink" href="manual" onclick="parent.prototypeClicks=(parent.prototypeClicks||0)+1">First drag link</a>
    <div id="box">Original text</div><section id="target">Target</section>
    <svg id="icon" width="40" height="40"><title>Logo</title><circle r="10" cx="20" cy="20"/></svg>
    <section id="gridParent"><div id="gridItem">Grid item</div></section>
    <section id="siblings">
      <div id="siblingDown" style="grid-column:2;grid-row:3">Down</div>
      <div id="siblingRight" style="grid-column:3;grid-row:2">Right</div>
      <div id="siblingCenter" style="grid-column:2;grid-row:2">Center <span id="nestedSibling">nested</span></div>
      <div id="siblingUp" style="grid-column:2;grid-row:1">Up</div>
      <div id="siblingLeft" style="grid-column:1;grid-row:2">Left</div>
      <div style="display:none">Hidden sibling</div>
      <div style="visibility:hidden;grid-column:2;grid-row:1">Invisible sibling</div>
    </section>
    <section id="swapRow"><div id="swapRowA">A</div><div id="swapRowB">B</div><div id="swapRowC">C</div><div id="swapRowD">D</div></section>
    <section id="swapColumn"><div id="swapColumnA">A</div><div id="swapColumnB">B</div><div id="swapColumnC">C</div></section>
    <section id="swapInline"><a id="swapInlineA" href="#">Alpha</a> <a id="swapInlineB" href="#">Beta</a> <a id="swapInlineC" href="#">Gamma</a></section>
    <section id="layoutChildren"><span id="layoutA">A</span><span id="layoutB">B</span><span id="layoutC">C</span></section>
    <section id="multiRowChildren"><span id="multiA">A</span><span id="multiB">B</span><span id="multiC">C</span><span id="multiD">D</span><span id="multiE">E</span><span id="multiF">F</span></section>
    <section id="wrappedRows"><ul id="wrappedFirst"><li id="wrappedA">A</li><li id="wrappedB">B</li><li id="wrappedC">C</li></ul><ul id="wrappedSecond"><li id="wrappedD">D</li><li id="wrappedE">E</li></ul></section>
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
  await page.goto(origin + session.editorUrl)
  await page.waitForFunction(() => document.querySelector('#dirty').textContent === '工作区已同步')
  await page.evaluate(() => {
    window.originalCanvasDocument = document.querySelector('#canvas').contentDocument
    window.originalBox = window.originalCanvasDocument.querySelector('#box')
    window.canvasLoads = 0
    document.querySelector('#canvas').addEventListener('load', () => window.canvasLoads++)
  })
  const canvas = page.frameLocator('#canvas')
  const box = canvas.locator('#box')
  assert.equal(await page.locator('#props').isVisible(), false)
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
    await page.waitForFunction(() => !document.querySelector('#dragMode').disabled)
  }
  await canvas.locator('#gridParent').click({ position: { x: 250, y: 120 } })
  assert.equal(await page.locator('#layoutHorizontal').isDisabled(), true)
  assert.equal(await page.locator('[name="childEdgeMode"][value="edge"]').isEnabled(), true)
  assert.equal(await page.locator('[name="childEdgeMode"][value="inset"]').isEnabled(), true)
  await page.locator('[name="childEdgeMode"][value="inset"]').check()
  await page.locator('[name="childEdgeMode"][value="edge"]').check()
  async function undo() { await page.locator('#undo').click(); await checkStable() }
  async function redo() { await page.locator('#redo').click(); await checkStable() }
  async function documentRect(locator) {
    return locator.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left + scrollX, top: rect.top + scrollY, width: rect.width, height: rect.height }
    })
  }
  async function assertPosition(locator, expected) {
    const actual = await documentRect(locator)
    assert.ok(Math.abs(actual.left - expected.left) < 1, `${await locator.getAttribute('id')}: ${JSON.stringify(actual)} versus ${JSON.stringify(expected)}`)
    assert.ok(Math.abs(actual.top - expected.top) < 1, `${await locator.getAttribute('id')}: ${JSON.stringify(actual)} versus ${JSON.stringify(expected)}`)
  }
  async function swapAndRestore(firstId, secondId, direction, count = 1, middleId) {
    const first = canvas.locator('#' + firstId), second = canvas.locator('#' + secondId)
    await first.click({ position: { x: 12, y: 12 } })
    await page.locator('#swapSteps').fill(String(count))
    await page.locator('#swapSteps').press('Enter')
    const before = [await documentRect(first), await documentRect(second)]
    const middle = middleId && await documentRect(canvas.locator('#' + middleId))
    const styles = [await first.getAttribute('style'), await second.getAttribute('style')]
    const contents = [await first.textContent(), await second.textContent()]
    const transforms = [await first.evaluate((element) => getComputedStyle(element).transform), await second.evaluate((element) => getComputedStyle(element).transform)]
    await page.evaluate(({ firstId, secondId }) => {
      const doc = document.querySelector('#canvas').contentDocument
      window.swapFirst = doc.getElementById(firstId)
      window.swapSecond = doc.getElementById(secondId)
    }, { firstId, secondId })
    await page.locator(`[data-swap="${direction}"]`).click()
    await assertPosition(first, before[1])
    await assertPosition(second, before[0])
    if (middleId) await assertPosition(canvas.locator('#' + middleId), middle)
    assert.equal(await page.locator('#selection').textContent(), await first.evaluate((element) => element.tagName.toLowerCase() + '#' + element.id))
    assert.deepEqual([await first.textContent(), await second.textContent()], contents)
    assert.deepEqual([await first.evaluate((element) => getComputedStyle(element).transform), await second.evaluate((element) => getComputedStyle(element).transform)], transforms)
    assert.equal(await page.evaluate(({ firstId, secondId }) => {
      const doc = document.querySelector('#canvas').contentDocument
      return swapFirst === doc.getElementById(firstId) && swapSecond === doc.getElementById(secondId)
    }, { firstId, secondId }), true)
    await checkStable()
    await undo()
    await assertPosition(first, before[0])
    await assertPosition(second, before[1])
    assert.equal(await first.getAttribute('style'), styles[0])
    assert.equal(await second.getAttribute('style'), styles[1])
    await redo()
    await assertPosition(first, before[1])
    await assertPosition(second, before[0])
    await undo()
  }
  // Drag without preselecting. Some prototypes activate links from pointerup;
  // ignored clicks must still prevent navigation and business click handlers.
  await drag(canvas.locator('#firstLink'), 25, 15)
  await checkStable()
  assert.equal(await page.evaluate(() => window.prototypeClicks || 0), 0)
  await undo()
  await redo()
  await box.click()
  assert.equal(await page.getByRole('tab').count(), 2)
  assert.equal(await page.locator('#positionTab').getAttribute('aria-selected'), 'true')
  assert.equal(await page.locator('#positionPanel').isVisible(), true)
  assert.equal(await page.locator('#attributesPanel').isVisible(), false)
  const beforeTabSwitch = await page.evaluate(() => ({
    dirty: document.querySelector('#dirty').textContent,
    undo: document.querySelector('#undo').disabled,
    redo: document.querySelector('#redo').disabled,
    selection: document.querySelector('#selection').textContent,
  }))
  await page.locator('#attributesTab').click()
  assert.equal(await page.locator('#positionPanel').isVisible(), false)
  assert.equal(await page.locator('#text').isVisible(), true)
  await page.locator('#text').fill('Unsaved inspector draft')
  await page.locator('#positionTab').click()
  await page.locator('#positionTab').press('ArrowRight')
  assert.equal(await page.locator('#attributesTab').evaluate((element) => element === document.activeElement), true)
  assert.equal(await page.locator('#text').inputValue(), 'Unsaved inspector draft')
  assert.equal(await box.textContent(), 'Original text')
  await page.locator('#attributesTab').press('Home')
  assert.equal(await page.locator('#positionTab').getAttribute('aria-selected'), 'true')
  await page.locator('#positionTab').press('End')
  assert.equal(await page.locator('#attributesTab').getAttribute('aria-selected'), 'true')
  await page.locator('#attributesTab').press('ArrowLeft')
  assert.equal(await page.locator('#positionTab').getAttribute('aria-selected'), 'true')
  assert.deepEqual(await page.evaluate(() => ({
    dirty: document.querySelector('#dirty').textContent,
    undo: document.querySelector('#undo').disabled,
    redo: document.querySelector('#redo').disabled,
    selection: document.querySelector('#selection').textContent,
  })), beforeTabSwitch)
  await checkStable()
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

  await box.dblclick()
  assert.equal(await page.locator('#attributesTab').getAttribute('aria-selected'), 'true')
  assert.equal(await page.locator('#text').evaluate((element) => element === document.activeElement), true)
  await page.locator('#text').fill('Edited text')
  await page.locator('#applyText').click()
  assert.equal(await box.textContent(), 'Edited text')
  await undo()
  assert.equal(await box.textContent(), 'Original text')
  await redo()
  assert.equal(await box.textContent(), 'Edited text')

  await page.locator('#positionTab').click()
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
  await page.locator('#attributesTab').click()
  await page.locator('#imageFile').setInputFiles({
    name: 'test.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9f8AAAAASUVORK5CYII=', 'base64'),
  })
  await canvas.locator('img#icon').waitFor()
  await undo()
  assert.equal(await canvas.locator('svg#icon circle').count(), 1)
  await redo()
  assert.equal(await canvas.locator('img#icon').count(), 1)

  await canvas.locator('#siblingCenter').click({ position: { x: 12, y: 12 } })
  assert.equal(await page.locator('#attributesTab').getAttribute('aria-selected'), 'true')
  await page.locator('#positionTab').click()
  for (const [direction, id] of [['left', 'siblingLeft'], ['right', 'siblingRight'], ['up', 'siblingUp'], ['down', 'siblingDown']]) {
    await canvas.locator('#siblingCenter').click({ position: { x: 12, y: 12 } })
    await page.locator(`[data-sibling="${direction}"]`).click()
    assert.equal(await page.locator('#selection').textContent(), 'div#' + id)
  }
  assert.equal(await page.locator('#siblingDown').isDisabled(), true)
  await canvas.locator('#siblingLeft').click()
  await drag(canvas.locator('#qp-manual-highlight [data-move]'), 180, 0)
  await canvas.locator('#siblingCenter').click({ position: { x: 12, y: 12 } })
  assert.equal(await page.locator('#siblingLeft').isDisabled(), true)
  await page.locator('#siblingRight').click()
  assert.equal(await page.locator('#selection').textContent(), 'div#siblingRight')
  await undo()
  await canvas.locator('#nestedSibling').click()
  for (const direction of ['left', 'right', 'up', 'down']) {
    assert.equal(await page.locator(`[data-sibling="${direction}"]`).isDisabled(), true)
    assert.equal(await page.locator(`[data-swap="${direction}"]`).isDisabled(), true)
  }
  for (const [direction, id] of [['left', 'siblingLeft'], ['right', 'siblingRight'], ['up', 'siblingUp'], ['down', 'siblingDown']])
    await swapAndRestore('siblingCenter', id, direction)
  await swapAndRestore('swapRowB', 'swapRowD', 'right', 2, 'swapRowC')
  await swapAndRestore('swapRowD', 'swapRowA', 'left', 3, 'swapRowB')
  await swapAndRestore('swapColumnA', 'swapColumnC', 'down', 2, 'swapColumnB')
  await swapAndRestore('swapColumnC', 'swapColumnA', 'up', 2, 'swapColumnB')
  await swapAndRestore('swapInlineA', 'swapInlineC', 'right', 2, 'swapInlineB')
  await canvas.locator('#layoutChildren').click({ position: { x: 8, y: 8 } })
  assert.equal(await page.locator('#layoutHorizontal').isEnabled(), true)
  await page.locator('#layoutHorizontal').click()
  assert.equal(await canvas.locator('#layoutChildren').evaluate((element) => getComputedStyle(element).justifyContent), 'space-between')
  assert.equal(await canvas.locator('#layoutA').evaluate((element) => Math.round(element.getBoundingClientRect().left - element.parentElement.getBoundingClientRect().left)), 20)
  await page.locator('[name="childEdgeMode"][value="inset"]').check()
  assert.equal(await canvas.locator('#layoutChildren').evaluate((element) => getComputedStyle(element).display), 'flex')
  assert.equal(await canvas.locator('#layoutChildren').evaluate((element) => getComputedStyle(element).justifyContent), 'space-evenly')
  const equalGaps = await canvas.locator('#layoutChildren').evaluate((element) => {
    const parent = element.getBoundingClientRect(), children = Array.from(element.children).map((child) => child.getBoundingClientRect())
    const style = getComputedStyle(element)
    const left = parent.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
    const right = parent.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight)
    return [children[0].left - left, children[1].left - children[0].right, children[2].left - children[1].right, right - children[2].right]
  })
  assert.ok(Math.max(...equalGaps) - Math.min(...equalGaps) < 1)
  await page.locator('#layoutCenter').click()
  assert.equal(await canvas.locator('#layoutChildren').evaluate((element) => getComputedStyle(element).alignItems), 'center')
  await page.locator('#layoutRight').click()
  assert.equal(await canvas.locator('#layoutChildren').evaluate((element) => getComputedStyle(element).justifyContent), 'flex-end')
  await undo()
  assert.equal(await canvas.locator('#layoutChildren').evaluate((element) => getComputedStyle(element).justifyContent), 'space-evenly')
  await page.locator('#layoutLeft').click()
  assert.equal(await canvas.locator('#layoutChildren').evaluate((element) => getComputedStyle(element).justifyContent), 'flex-start')
  await canvas.locator('#multiRowChildren').click({ position: { x: 290, y: 75 } })
  assert.equal(await page.locator('#childLayoutRowPicker').isVisible(), true)
  assert.equal(await page.locator('#childLayoutRow option').count(), 3)
  assert.equal(await page.locator('#layoutHorizontal').isDisabled(), true)
  const firstRowBefore = await canvas.locator('#multiA').evaluate((element) => element.getBoundingClientRect().left)
  const secondRowBefore = await canvas.locator('#multiD').evaluate((element) => element.getBoundingClientRect().left)
  await page.locator('#childLayoutRow').selectOption('1')
  assert.equal(await page.locator('#layoutHorizontal').isEnabled(), true)
  await page.locator('[name="childEdgeMode"][value="edge"]').check()
  await page.locator('#layoutHorizontal').click()
  assert.equal(await canvas.locator('#multiA').evaluate((element) => element.getBoundingClientRect().left), firstRowBefore)
  assert.notEqual(await canvas.locator('#multiD').evaluate((element) => element.getBoundingClientRect().left), secondRowBefore)
  await canvas.locator('#wrappedRows').click({ position: { x: 290, y: 70 } })
  assert.equal(await page.locator('#childLayoutRow option').count(), 3)
  assert.match(await page.locator('#childLayoutRow option').nth(1).textContent(), /3 个元素（已进入包裹层）/)
  await page.locator('#childLayoutRow').selectOption('0')
  assert.equal(await page.locator('#layoutHorizontal').isEnabled(), true)
  await page.locator('#layoutHorizontal').click()
  assert.equal(await canvas.locator('#wrappedFirst').evaluate((element) => getComputedStyle(element).justifyContent), 'space-between')
  await canvas.locator('#swapRowB').click({ position: { x: 12, y: 12 } })
  await page.locator('#swapSteps').fill('99')
  await page.locator('#swapSteps').press('Enter')
  for (const direction of ['left', 'right', 'up', 'down'])
    assert.equal(await page.locator(`[data-swap="${direction}"]`).isDisabled(), true)
  await page.locator('#swapSteps').fill('2')
  await page.locator('#swapSteps').press('Enter')
  await page.locator('#swapRight').click()
  await page.locator('#swapSteps').fill('1')
  await page.locator('#swapSteps').press('Enter')
  await checkStable()
  await box.click()
  assert.equal(await page.locator('#gridSettings').isVisible(), false)
  await page.locator('#dragMode').selectOption('grid')
  assert.equal(await page.locator('#gridSettings').isVisible(), true)
  assert.equal(await page.locator('#gridSize').inputValue(), '30')
  const gridItem = canvas.locator('#gridItem')
  await gridItem.click()
  assert.equal(await page.locator('#gridSize').inputValue(), '20')
  async function gridRect() {
    return gridItem.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const parent = element.parentElement.getBoundingClientRect()
      return { left: rect.left + scrollX, top: rect.top + scrollY, right: rect.right + scrollX, bottom: rect.bottom + scrollY,
        parent: { left: parent.left + scrollX, top: parent.top + scrollY, right: parent.right + scrollX, bottom: parent.bottom + scrollY } }
    })
  }
  function withinParent(rect) {
    assert.ok(rect.left >= rect.parent.left - 1 && rect.top >= rect.parent.top - 1, JSON.stringify(rect))
    assert.ok(rect.right <= rect.parent.right + 1 && rect.bottom <= rect.parent.bottom + 1, JSON.stringify(rect))
  }
  function onGrid(rect, step) {
    for (const value of [rect.left, rect.top])
      assert.ok(Math.abs(value / step - Math.round(value / step)) < 0.05, `${value} is not on a ${step}px grid`)
    withinParent(rect)
  }
  const originalGridStyle = await gridItem.getAttribute('style')
  await drag(gridItem, 47, 23)
  onGrid(await gridRect(), 20)
  const automaticStyle = await gridItem.getAttribute('style')
  await undo()
  assert.equal(await gridItem.getAttribute('style'), originalGridStyle)
  await redo()
  assert.equal(await gridItem.getAttribute('style'), automaticStyle)
  await page.locator('#gridSize').fill('40')
  await page.locator('#gridSize').press('Enter')
  assert.equal(await page.locator('#gridAuto').isChecked(), false)
  await drag(canvas.locator('#qp-manual-highlight [data-move]'), 53, 28)
  onGrid(await gridRect(), 40)
  const manualStyle = await gridItem.getAttribute('style')
  await undo()
  assert.equal(await gridItem.getAttribute('style'), automaticStyle)
  await redo()
  assert.equal(await gridItem.getAttribute('style'), manualStyle)
  await box.click()
  assert.equal(await page.locator('#gridSize').inputValue(), '40')
  await gridItem.click()
  await page.locator('#gridAuto').check()
  assert.equal(await page.locator('#gridSize').inputValue(), '20')
  await drag(canvas.locator('#qp-manual-highlight [data-move]'), 400, 200)
  withinParent(await gridRect())
  await checkStable()
  await page.locator('#dragMode').selectOption('free')
  assert.equal(await page.locator('#gridSettings').isVisible(), false)
  const beforeFree = await gridRect()
  await drag(canvas.locator('#qp-manual-highlight [data-move]'), 13, 7)
  const afterFree = await gridRect()
  assert.ok(Math.abs(afterFree.left - beforeFree.left - 13) < 1)
  assert.ok(Math.abs(afterFree.top - beforeFree.top - 7) < 1)
  await undo()
  await page.locator('#dragMode').selectOption('parent')
  assert.equal(await page.locator('#gridSettings').isVisible(), false)

  await box.click()
  assert.equal(await page.locator('#dragMode option[value="reorder"]').count(), 0)
  await page.locator('#dragMode').selectOption('grid')
  await page.locator('#gridSize').fill('30')
  await page.locator('#gridSize').press('Tab')
  assert.equal(await page.locator('#gridSize').isDisabled(), false)
  const beforeGrid = await box.getAttribute('style')
  const handleRect = await canvas.locator('#qp-manual-highlight [data-move]').boundingBox()
  await page.mouse.move(handleRect.x + 10, handleRect.y + 10)
  await page.mouse.down()
  await page.mouse.move(handleRect.x + 27, handleRect.y + 23, { steps: 10 })
  await page.mouse.up()
  await page.waitForFunction(() => !document.querySelector('#dragMode').disabled)
  const afterGrid = await box.getAttribute('style')
  assert.notEqual(afterGrid, beforeGrid)
  await undo()
  assert.equal(await box.getAttribute('style'), beforeGrid)
  await redo()
  assert.equal(await box.getAttribute('style'), afterGrid)

  // New edits after undo must discard only the redo branch, not earlier changes.
  await undo()
  await page.locator('#attributesTab').click()
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
  assert.equal(await page.locator('#versionDialog').isVisible(), true)
  await page.locator('#cancelVersion').click()
  assert.equal(await page.locator('#save').isEnabled(), true)
  await page.locator('#save').click()
  await page.locator('#versionFeedback').fill('  调整元素尺寸、位置和文字  ')
  const submissionResponse = page.waitForResponse((response) =>
    response.url().endsWith('/__layrr__/manual-data') && response.request().method() === 'POST')
  await page.locator('#versionForm button[type="submit"]').click()
  const queuedSubmission = await (await submissionResponse).json()
  assert.ok(queuedSubmission.submissionId)
  const pending = await fetch(origin + '/api/layrr/' + session.id, { headers }).then((response) => response.json())
  assert.equal(pending.submission.feedbackText, '调整元素尺寸、位置和文字')
  await fetch(origin + '/api/layrr/' + session.id, {
    method: 'POST', headers,
    body: JSON.stringify({ submissionId: pending.submission.id, success: true, message: '已保存为 v2' }),
  })
  await page.waitForFunction(() => document.querySelector('#dirty').textContent === '工作区已同步')
  assert.equal(await page.locator('#versionFeedback').inputValue(), '')
  assert.equal(await page.locator('#save').count(), 1)
  const saved = await fetch(origin + session.url + '__layrr__/manual-data', {
    headers: { 'x-quickpage-manual': '1' },
  }).then((res) => res.json())
  assert.match(saved.html, /Edited text/)
  assert.match(saved.html, /width: 240px/)
  assert.match(saved.html, /translate:/)
  assert.match(saved.html, /id="gridItem" style="[^"]*translate:/)
  assert.match(saved.html, /id="swapRowB" style="[^"]*translate:/)
  assert.match(saved.html, /id="swapRowD" style="[^"]*translate:/)
  assert.doesNotMatch(saved.html, /data-quickpage-manual-node|qp-manual-highlight|data-runtime/)
  await checkStable()

  if (process.env.QUICKPAGE_MANUAL_SCREENSHOT_DIR) {
    await page.locator('#dragMode').selectOption('grid')
    await page.locator('#gridAuto').check()
    for (const width of [1200, 960]) {
      await page.setViewportSize({ width, height: 900 })
      await canvas.locator('#siblingCenter').click({ position: { x: 12, y: 12 } })
      await page.locator('#positionTab').click()
      await page.locator('#positionPanel').evaluate((element) => { element.scrollTop = 0 })
      const layout = await page.evaluate(() => {
        const header = document.querySelector('header').getBoundingClientRect()
        const controls = Array.from(document.querySelector('header').children)
          .map((element) => element.getBoundingClientRect()).filter((rect) => rect.width && rect.height)
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          clipped: controls.some((rect) => rect.left < 0 || rect.right > innerWidth || rect.bottom > header.bottom),
          overlaps: controls.some((a, index) => controls.slice(index + 1).some((b) =>
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)),
        }
      })
      assert.deepEqual(layout, { overflow: false, clipped: false, overlaps: false })
      await page.screenshot({ path: join(process.env.QUICKPAGE_MANUAL_SCREENSHOT_DIR, `manual-editor-${width}.png`) })
      await page.locator('#attributesTab').click()
      await page.locator('#attributesPanel').evaluate((element) => { element.scrollTop = 0 })
      assert.equal(await page.locator('#positionPanel').isVisible(), false)
      assert.equal(await page.locator('#attributesPanel').isVisible(), true)
      const panelLayout = await page.locator('#attributesPanel').evaluate((element) => ({
        overflow: element.scrollWidth > element.clientWidth,
        tabsVisible: document.querySelector('#attributesTab').getBoundingClientRect().bottom <= element.getBoundingClientRect().top,
      }))
      assert.deepEqual(panelLayout, { overflow: false, tabsVisible: true })
      await page.screenshot({ path: join(process.env.QUICKPAGE_MANUAL_SCREENSHOT_DIR, `manual-attributes-${width}.png`) })
    }
    await checkStable()
  }
})
