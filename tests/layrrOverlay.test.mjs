import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { adaptLayrrOverlay, adaptLayrrWorkspaceOverlay } from '../server/layrrOverlay.ts'

const require = createRequire(import.meta.url)
const original = await readFile(
  join(require.resolve('layrr/package.json'), '..', 'dist/overlay.js'),
  'utf8',
)

test('installed official overlay is adapted without changing display helpers', () => {
  const adapted = adaptLayrrOverlay(original)
  const start = original.indexOf('  function getSelector(el) {')
  assert.equal(adapted.slice(0, start), original.slice(0, start))
  assert.equal(
    adapted.slice(adapted.indexOf('  function posHL(', start)),
    original.slice(original.indexOf('  function posHL(', start)),
  )
})

test('selector escapes Tailwind classes and IDs, retaining sibling positions', () => {
  const adapted = adaptLayrrOverlay(original)
  const start = adapted.indexOf('  function getSelector(el) {')
  const end = adapted.indexOf('  function posHL(', start)
  const escaped = []
  const body = { children: [] }
  const getSelector = runInNewContext(adapted.slice(start, end) + 'getSelector', {
    document: { body },
    CSS: { escape(value) { escaped.push(value); return 'escaped-' + escaped.length } },
  })
  const parent = { tagName: 'DIV', id: 'panel:main', parentElement: body, children: [] }
  const first = { tagName: 'H3' }
  const target = {
    tagName: 'H3', className: 'text-[13px] font-semibold', parentElement: parent,
  }
  parent.children = [first, target]
  assert.equal(getSelector(target), '#escaped-3 > h3.escaped-1.escaped-2:nth-of-type(2)')
  assert.deepEqual(escaped, ['text-[13px]', 'font-semibold', 'panel:main'])
  for (const className of ['hover:bg-blue-500', 'w-1/2', 'p-2.5', 'grid-cols-[1fr_2fr]']) {
    escaped.length = 0
    getSelector({ tagName: 'DIV', className, parentElement: body })
    assert.deepEqual(escaped, [className])
  }
  escaped.length = 0
  assert.equal(getSelector({ id: 'item.[1]:2' }), '#escaped-1')
  assert.deepEqual(escaped, ['item.[1]:2'])
})

test('unsupported overlay source fails explicitly instead of silently mispatching', () => {
  assert.throws(() => adaptLayrrOverlay('unrecognised overlay'), /不兼容/)
})

test('embedded workspace starts in edit mode and deduplicates WebSocket/poll results before reload', () => {
  const adapted = adaptLayrrWorkspaceOverlay(original)
  new Function(adapted)
  assert.match(adapted, /if \(!saved.mode\) saved.mode = "edit"/)
  const start = adapted.indexOf('    function onEditResult(msg) {')
  const end = adapted.indexOf('    function connectWs()', start)
  const app2 = { lastEditTimestamp: 0 }
  let saves = 0
  let toasts = 0
  const onEditResult = runInNewContext(adapted.slice(start, end) + 'onEditResult', {
    app2,
    save2() { saves++ },
    stopPolling() {},
    toast2() { toasts++ },
  })
  onEditResult({ timestamp: 100, success: false, message: 'retry' })
  onEditResult({ timestamp: 100, success: false, message: 'retry' })
  assert.equal(app2.lastEditTimestamp, 100)
  assert.equal(saves, 1)
  assert.equal(toasts, 1)
})

test('workspace toasts sit above the editor bar at the top and wrap long error text', () => {
  const adapted = adaptLayrrWorkspaceOverlay(original)
  assert.match(adapted, /#\$\{L\}-toasts\{position:fixed;top:16px;bottom:auto;right:16px;z-index:1000000;/)
  assert.match(adapted, /#\$\{L\}-bar\{\s*position:fixed;bottom:16px;right:16px;z-index:999999;/)
  assert.match(adapted, /max-width:min\(420px,calc\(100vw - 32px\)\)/)
  assert.match(adapted, /\.\$\{L\}-toast span\{min-width:0;white-space:normal;overflow-wrap:anywhere\}/)
  assert.match(adapted, /text\.textContent = String\(msg\)/)
  assert.doesNotMatch(adapted, /el\.innerHTML = `<i class="\$\{ic\}"><\/i><span>\$\{msg\}<\/span>`/)
})
