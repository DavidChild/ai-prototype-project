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

test('workspace editor bar uses a stable shadow without backdrop compositing', () => {
  const adapted = adaptLayrrWorkspaceOverlay(original)
  assert.match(adapted, /backdrop-filter:none;-webkit-backdrop-filter:none;backface-visibility:hidden/)
  assert.match(adapted, /box-shadow:0 6px 18px rgba\(0,0,0,\.32\)/)
  assert.match(adapted, /transition:border-color \.12s/)
  assert.doesNotMatch(adapted, /backdrop-filter:blur\(16px\) saturate\(1\.2\)/)
  assert.doesNotMatch(adapted, /transition:box-shadow \.12s/)
})

test('workspace edit panel provides a four-times larger responsive editing area', () => {
  const adapted = adaptLayrrWorkspaceOverlay(original)
  assert.match(adapted, /width:min\(640px,calc\(100vw - 32px\)\)/)
  assert.match(adapted, /max-height:min\(560px,calc\(100vh - 72px\)\)/)
  assert.match(adapted, /min-height:240px;max-height:480px/)
  assert.doesNotMatch(adapted, /\.\$\{L\}-panel\{\s*display:none;width:320px;max-height:280px/)
})

test('workspace overlay localizes all primary Layrr controls and feedback', () => {
  const adapted = adaptLayrrWorkspaceOverlay(original)
  for (const text of [
    'AI 局部编辑',
    '描述你希望 AI 如何修改选中元素…',
    '修改历史',
    '暂无修改记录',
    '点击选择一个元素',
    'AI 正在修改…',
    '修改完成',
    '确认恢复到此版本？',
  ]) assert.ok(adapted.includes(text), `missing localized text: ${text}`)
  for (const text of [
    'Describe the change...',
    'Click to select an element',
    'Edit timed out',
    'Done!',
    'Revert to this version?',
  ]) assert.ok(!adapted.includes(text), `found untranslated text: ${text}`)
})

test('workspace overlay accepts one reference image with or without written instructions', () => {
  const adapted = adaptLayrrWorkspaceOverlay(original)
  assert.match(adapted, /title="上传参考图"/)
  assert.match(adapted, /<span>上传参考图<\/span>/)
  assert.match(adapted, /Ctrl\+V 粘贴图片/)
  assert.match(adapted, /在选定区块的上、下、左、右追加或还原参考图内容/)
  assert.match(adapted, /grid-template-columns:auto minmax\(0,1fr\)/)
  assert.match(adapted, /accept="image\/png,image\/jpeg,image\/webp"/)
  assert.match(adapted, /参考图不能超过 2 MB/)
  assert.match(adapted, /attachments: app2\.attachments/)
  assert.match(adapted, /typedInstruction \|\| \(app2\.attachments\?\.length/)
  assert.match(adapted, /panel\.addEventListener\("paste"/)
  assert.match(adapted, /event\.clipboardData\?\.items/)
  assert.match(adapted, /imageItem\?\.getAsFile\(\)/)
  assert.match(adapted, /clearEditAttachments2\(\)/)
})
