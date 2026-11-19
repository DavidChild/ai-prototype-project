import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { htmlRevision, manualEditorShell, validateManualSave } from '../server/layrrManual.ts'
import { textSelection } from '../server/layrrManualText.js'
import {
  applyElementSize,
  applyFreeDrag,
  dragTranslation,
  keyboardCommand,
  moveModule,
  normalizeGridStep,
  automaticGridStep,
  directionalSibling,
  nthDirectionalSibling,
  siblingSwapTranslations,
  childLayoutStyles,
  applyChildLayout,
  groupChildLayoutRows,
  childRowLayoutOffsets,
  resizeBox,
} from '../server/layrrManualLayout.js'

test('manual inspector separates position controls and element attributes into accessible tabs', () => {
  const shell = manualEditorShell('/api/layrr/test')
  assert.match(shell, /role="tablist" aria-label="元素编辑分类"/)
  assert.match(shell, /id="positionTab"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="positionPanel"[^>]*tabindex="0">位置与选择/)
  assert.match(shell, /id="attributesTab"[^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-controls="attributesPanel"[^>]*tabindex="-1">元素属性/)
  const position = shell.match(/<section id="positionPanel"[^>]*>([\s\S]*?)<\/section>/)?.[1]
  const attributes = shell.slice(shell.indexOf('<section id="attributesPanel"'), shell.indexOf('</aside>'))
  assert.ok(position)
  for (const id of ['parent', 'child', 'siblingLeft', 'swapSteps', 'swapRight', 'zIndex', 'children', 'layoutHorizontal', 'layoutCenter', 'layoutLeft', 'layoutRight', 'duplicate', 'delete'])
    assert.ok(position.includes(`id="${id}"`))
  for (const action of ['top', 'bottom', 'raise', 'lower'])
    assert.ok(position.includes(`data-layer="${action}"`))
  for (const label of ['置于顶层', '置于底层', '提升一层', '下移一层'])
    assert.ok(position.includes(label))
  for (const id of ['text', 'applyText', 'imageEditor', 'imageFile', 'imageUrl', 'color', 'width', 'height', 'padding', 'margin']) {
    assert.ok(attributes.includes(`id="${id}"`))
    assert.ok(!position.includes(`id="${id}"`))
  }
  assert.match(attributes, /^<section[^>]*role="tabpanel"[^>]*aria-labelledby="attributesTab" hidden>/)
  assert.match(shell, /\.editor-panel\[hidden\]\{display:none\}/)
})

test('child layout maps alignment actions to flex styles and edge strategies', () => {
  assert.deepEqual(childLayoutStyles('horizontal', 'edge'), {
    display: 'flex', 'flex-direction': 'row', 'flex-wrap': 'nowrap', 'justify-content': 'space-between',
  })
  assert.deepEqual(childLayoutStyles('horizontal', 'inset', 4), {
    display: 'flex', 'flex-direction': 'row', 'flex-wrap': 'nowrap', 'justify-content': 'space-evenly',
  })
  assert.equal(childLayoutStyles('center')['align-items'], 'center')
  assert.equal(childLayoutStyles('left')['justify-content'], 'flex-start')
  assert.equal(childLayoutStyles('right')['justify-content'], 'flex-end')
  assert.throws(() => childLayoutStyles('diagonal'), /无效/)
  assert.throws(() => childLayoutStyles('horizontal', 'outside'), /无效/)

  const values = new Map()
  const children = Array.from({ length: 4 }, () => ({
    style: { setProperty: (name, value, priority) => values.set(`${name}:${value}`, priority) },
  }))
  applyChildLayout({
    children,
    style: {
      getPropertyValue: () => '',
      removeProperty: () => {},
      setProperty: (name, value, priority) => values.set(name, [value, priority]),
    },
  }, 'horizontal', 'inset', children)
  assert.deepEqual(values.get('justify-content'), ['space-evenly', 'important'])
  assert.deepEqual(values.get('display'), ['flex', 'important'])
})

test('multi-row child layout requires an explicit row and calculates only that row offsets', () => {
  const item = (id, left, top, width = 40, height = 20) => ({ id, rect: { left, top, right: left + width, bottom: top + height, width, height } })
  const rows = groupChildLayoutRows([
    item('b2', 90, 70), item('a1', 10, 20), item('b1', 20, 70), item('a2', 80, 20),
  ])
  assert.deepEqual(rows.map((row) => row.map(({ id }) => id)), [['a1', 'a2'], ['b1', 'b2']])
  const edge = childRowLayoutOffsets(rows[1], 'horizontal', 'edge', { left: 0, right: 200 })
  assert.deepEqual(edge.map(({ item, dx, dy }) => [item.id, dx, dy]), [['b1', -20, 0], ['b2', 70, 0]])
  const inset = childRowLayoutOffsets(rows[1], 'horizontal', 'inset', { left: 0, right: 200 })
  assert.deepEqual(inset.map(({ item, dx }) => [item.id, dx]), [['b1', 20], ['b2', 30]])
  assert.throws(() => childRowLayoutOffsets([], 'horizontal', 'edge', { left: 0, right: 200 }), /选择/)
})

test('sibling selection follows visual directions instead of DOM order', () => {
  const rect = (left, top, width = 40, height = 40) => ({ left, top, right: left + width, bottom: top + height })
  const selected = rect(100, 100)
  const candidates = [
    { key: 'down', rect: rect(100, 160) },
    { key: 'right', rect: rect(160, 100) },
    { key: 'invisible', rect: rect(90, 100, 0, 0) },
    { key: 'up', rect: rect(100, 40) },
    { key: 'farLeft', rect: rect(-20, 100) },
    { key: 'left', rect: rect(40, 100) },
  ]
  for (const direction of ['left', 'right', 'up', 'down'])
    assert.equal(directionalSibling(selected, candidates, direction), direction)
  assert.equal(directionalSibling(selected, [], 'left'), null)
  assert.equal(directionalSibling(selected, candidates, 'invalid'), null)
  assert.equal(directionalSibling(selected, [{ key: 'farLeft', rect: rect(-20, 100) }, { key: 'diagonal', rect: rect(70, 150) }], 'left'), 'farLeft')
  assert.equal(directionalSibling(selected, [{ key: 'diagonal', rect: rect(70, 150) }], 'left'), 'diagonal')
  assert.equal(directionalSibling(selected, [{ key: 'overlap', rect: selected }], 'left'), null)
})

test('cross-sibling targets count in the chosen visual direction without mutating the middle nodes', () => {
  const rect = (x, y) => ({ left: x, top: y, right: x + 20, bottom: y + 20 })
  const selected = rect(100, 100)
  const candidates = []
  for (const [direction, dx, dy] of [['left', -40, 0], ['right', 40, 0], ['up', 0, -40], ['down', 0, 40]])
    for (let index = 3; index >= 1; index--)
      candidates.push({ key: direction + index, rect: rect(100 + dx * index, 100 + dy * index) })
  const original = structuredClone(candidates)
  for (const direction of ['left', 'right', 'up', 'down']) {
    for (let count = 1; count <= 3; count++)
      assert.equal(nthDirectionalSibling(selected, candidates, direction, count), direction + count)
    assert.equal(nthDirectionalSibling(selected, candidates, direction, 4), null)
  }
  for (const count of [0, -1, 1.5, Infinity, 999])
    assert.equal(nthDirectionalSibling(selected, candidates, 'right', count), null)
  assert.deepEqual(candidates, original)
})

test('position swaps preserve existing translations and use the parent coordinate system', () => {
  const first = { rect: { left: 10, top: 20 }, translate: '10px 20px', inverse: { a: 1, b: 0, c: 0, d: 1 } }
  const second = { rect: { left: 110, top: 170 }, translate: 'none', inverse: first.inverse }
  assert.deepEqual(siblingSwapTranslations(first, second), ['calc(10px + 100px) calc(20px + 150px)', '-100px -150px'])
  const scaled = { a: 0.5, b: 0, c: 0, d: 0.5 }
  assert.deepEqual(siblingSwapTranslations({ ...first, inverse: scaled }, { ...second, inverse: scaled }),
    ['calc(10px + 50px) calc(20px + 75px)', '-50px -75px'])
  const rotated = { a: 0, b: -1, c: 1, d: 0 }
  assert.deepEqual(siblingSwapTranslations({ ...first, inverse: rotated }, { ...second, inverse: rotated }),
    ['calc(10px + 150px) calc(20px - 100px)', '-150px 100px'])
  assert.throws(() => siblingSwapTranslations(first, { ...second, inverse: { a: NaN, b: 0, c: 0, d: 1 } }), /无效拖动/)
})

test('grid steps are editable, normalized and automatically inferred from parent gaps', () => {
  for (const [value, expected] of [[30, 30], ['45', 45], ['12.7', 13], [0, 1], [-10, 1], [900, 500], ['', 30], ['bad', 30], [Infinity, 30]])
    assert.equal(normalizeGridStep(value), expected)
  assert.equal(automaticGridStep({ rowGap: '24px', columnGap: '16px' }), 16)
  assert.equal(automaticGridStep({ rowGap: 'normal', columnGap: '20px' }), 20)
  assert.equal(automaticGridStep({ rowGap: '0px', columnGap: '0px' }), 30)
  assert.equal(automaticGridStep({ rowGap: '10%', columnGap: 'normal' }), 30)
  assert.equal(automaticGridStep(), 30)
})

test('grid drag combines live-configurable snapping with parent restriction for both drag targets', async () => {
  const client = await readFile(new URL('../server/layrrManualClient.js', import.meta.url), 'utf8')
  const inputs = { dragMode: { value: 'grid' }, gridSize: { value: '30' }, gridAuto: { checked: true } }
  const parent = {}
  const live = { parentElement: parent }
  const context = {
    $: (id) => inputs[id], normalizeGridStep, automaticGridStep, status: () => {},
    gesture: null, selectedKey: 'test', marker: 'test-node',
    frame: {
      contentDocument: { querySelector: () => live },
      contentWindow: { getComputedStyle: () => ({ rowGap: '20px' }) },
    },
    window: { interact: {
      modifiers: {
        snap: (options) => ({ type: 'snap', options }),
        restrictRect: (options) => ({ type: 'restrict', options }),
      },
      snappers: { grid: (step) => (x, y) => ({ x: Math.round(x / step.x) * step.x, y: Math.round(y / step.y) * step.y }) },
    } },
  }
  const helpers = runInNewContext(
    client.slice(client.indexOf('function positionDragMode()'), client.indexOf('function registerNodes()')) +
      '\n;({ dragOptions, syncGridStep })', context,
  )
  for (const handle of [false, true]) {
    const options = helpers.dragOptions(handle)
    assert.equal(options.modifiers.length, 2)
    const [snap, restrict] = options.modifiers
    assert.equal(snap.type, 'snap')
    assert.equal(snap.options.range, Infinity)
    assert.equal(snap.options.relativePoints[0].x, 0)
    assert.equal(snap.options.relativePoints[0].y, 0)
    inputs.gridSize.value = '30'
    assert.equal(snap.options.targets[0](44, 31).x, 30)
    inputs.gridSize.value = '20'
    assert.equal(snap.options.targets[0](44, 31).x, 40)
    assert.equal(restrict.options.endOnly, true)
    assert.equal(handle ? restrict.options.restriction() : restrict.options.restriction, handle ? parent : 'parent')
    assert.equal(options.inertia.allowResume, false)
  }
  inputs.gridSize.value = '45'
  inputs.gridAuto.checked = false
  helpers.syncGridStep(live)
  assert.equal(inputs.gridSize.value, '45')
  inputs.gridAuto.checked = true
  helpers.syncGridStep(live)
  assert.equal(inputs.gridSize.value, '20')
  inputs.dragMode.value = 'parent'
  assert.equal(helpers.dragOptions().modifiers.length, 1)
  inputs.dragMode.value = 'free'
  assert.equal(helpers.dragOptions().modifiers.length, 0)
})

test('local editing opens and reopens the original manual workspace', async () => {
  const source = await readFile(new URL('../src/components/workbench/LayrrEditor.vue', import.meta.url), 'utf8')
  assert.ok(source.includes("window.open('about:blank', '_blank')"))
  assert.ok(source.includes('popup.location.href = workspace.value.editorUrl'))
  assert.ok(source.includes('editorUrl: string'))
  assert.match(source, /html: original/)
  assert.doesNotMatch(source, /tmagic-editor/)
})

test('undo/redo and ordinary commits never reload the preview document', async () => {
  const client = await readFile(new URL('../server/layrrManualClient.js', import.meta.url), 'utf8')
  const restore = client.slice(client.indexOf('function restore(delta)'), client.indexOf("$('undo').onclick"))
  const commit = client.slice(client.indexOf('function commit('), client.indexOf('function editableText('))
  for (const block of [restore, commit]) {
    assert.match(block, /applyDomChanges/)
    assert.doesNotMatch(block, /render\(|srcdoc|DOMParser|location\.reload|document\.write/)
  }
  // Only initial/explicit workspace reload may recreate the iframe.
  assert.equal((client.match(/render\(null\)/g) || []).length, 1)
})

test('ignored post-drag clicks still block prototype navigation and click handlers', async () => {
  const client = await readFile(new URL('../server/layrrManualClient.js', import.meta.url), 'utf8')
  const click = client.slice(client.indexOf("    'click',"), client.indexOf("    'dblclick',"))
  const ignore = click.indexOf('if (suppressClick')
  assert.ok(ignore > 0)
  assert.ok(click.indexOf('event.preventDefault()') < ignore)
  assert.ok(click.indexOf('event.stopImmediatePropagation()') < ignore)
})

test('module gestures reject cycles and keyboard shortcuts respect text inputs', () => {
  const source = { contains: (target) => target.child === true }
  assert.throws(() => moveModule(source, source, 'before'))
  assert.throws(() => moveModule(source, { child: true }, 'inside'))
  assert.throws(() => moveModule(source, { tagName: 'H4' }, 'inside'))
  let moved
  moveModule(
    source,
    {
      tagName: 'SECTION',
      append: (node) => {
        moved = node
      },
    },
    'inside',
  )
  assert.equal(moved, source)
  assert.equal(keyboardCommand({ key: 'z', ctrlKey: true }), 'undo')
  assert.equal(keyboardCommand({ key: 'z', metaKey: true, shiftKey: true }), 'redo')
  assert.equal(keyboardCommand({ key: 'Delete' }), 'delete')
  assert.equal(keyboardCommand({ key: 'Delete', target: { closest: () => ({}) } }), null)
  assert.equal(keyboardCommand({ key: 'z', ctrlKey: true, isComposing: true }), null)
})

test('free drag and eight-direction resize persist CSS geometry without replacing transforms', () => {
  assert.equal(dragTranslation('10px 20px', 15, -5), 'calc(10px + 15px) calc(20px - 5px)')
  assert.equal(dragTranslation('none', 12, 8), '12px 8px')
  assert.deepEqual(resizeBox({ width: 100, height: 60 }, { width: 30, height: -10 }, { left: true, top: true }), {
    width: 130,
    height: 50,
    dx: -30,
    dy: 10,
  })
  const values = new Map()
  const node = {
    style: {
      setProperty(name, value) {
        values.set(name, value)
      },
    },
  }
  applyFreeDrag(node, '12px 8px')
  applyElementSize(node, { width: 130, height: 50 }, true)
  assert.equal(values.get('translate'), '12px 8px')
  assert.equal(values.get('width'), '130px')
  assert.equal(values.get('height'), '50px')
  assert.equal(values.get('min-width'), '0px')
  assert.equal(values.get('display'), 'inline-block')
})

import {
  imageTarget,
  imageUrl,
  replaceImage,
  validateImageFile,
} from '../server/layrrManualImage.js'

const textNode = (value) => ({ nodeType: 3, nodeValue: value })
function element(tagName, childNodes = [], attributes = {}) {
  return {
    nodeType: 1,
    tagName,
    childNodes,
    style: {},
    getAttribute: (key) => attributes[key] ?? null,
  }
}

test('icon plus direct or nested text can be edited without replacing child structure', () => {
  for (const nested of [false, true]) {
    const text = textNode('  由你授权 · 随时可控  ')
    const iconText = textNode('shield icon')
    const icon = element('SVG', [element('TITLE', [iconText])])
    const label = nested ? element('SPAN', [text]) : text
    const root = element('DIV', [icon, label])
    const selection = textSelection(root)
    assert.equal(selection.value, '由你授权 · 随时可控')
    assert.equal(selection.editable, true)
    selection.apply('新文字')
    assert.equal(text.nodeValue, '  新文字  ')
    assert.equal(root.childNodes[0], icon)
    assert.equal(root.childNodes[1], label)
    assert.equal(iconText.nodeValue, 'shield icon')
  }
})

test('multiple text nodes are displayed but cannot flatten nested formatting', () => {
  const one = textNode('由你授权'),
    two = textNode('随时可控')
  const root = element('DIV', [one, element('STRONG', [two])])
  const selection = textSelection(root)
  assert.equal(selection.value, '由你授权\n随时可控')
  assert.equal(selection.editable, false)
  assert.throws(() => selection.apply('replace everything'), /选择子级/)
  assert.equal(two.nodeValue, '随时可控')
})

test('a selected text segment in nested HTML is editable without changing sibling markup', () => {
  const first = textNode('标题 ')
  const nestedText = textNode('可编辑内容')
  const strong = element('STRONG', [nestedText])
  const root = element('DIV', [first, strong])
  const summary = textSelection(root, -1)
  assert.equal(summary.editable, false)
  assert.equal(summary.segments.length, 2)
  const selected = textSelection(root, 1)
  assert.equal(selected.editable, true)
  assert.equal(selected.value, '可编辑内容')
  selected.apply('修改后的内容')
  assert.equal(first.nodeValue, '标题 ')
  assert.equal(nestedText.nodeValue, '修改后的内容')
  assert.equal(root.childNodes[1], strong)
})

test('hidden decorative text and scripts do not become editable business text', () => {
  const root = element('DIV', [
    element('SPAN', [textNode('icon')], { 'aria-hidden': 'true' }),
    element('SCRIPT', [textNode('run()')]),
    textNode('正文'),
  ])
  assert.equal(textSelection(root).value, '正文')
  assert.equal(textSelection(root).editable, true)
  assert.equal(textSelection(element('SVG', [textNode('icon')])).editable, false)
})

test('image replacements validate sources and retain useful attributes safely', () => {
  assert.equal(imageUrl('https://example.com/a.svg'), 'https://example.com/a.svg')
  for (const value of [
    'javascript:alert(1)',
    'data:image/svg+xml,test',
    'https://user:pass@example.com/a.png',
    '/relative.png',
  ])
    assert.throws(() => imageUrl(value))
  assert.throws(() => validateImageFile({ type: 'text/html', size: 10 }), /请选择/)
  assert.throws(() => validateImageFile({ type: 'image/png', size: 2 * 1024 * 1024 + 1 }), /2 MB/)
  validateImageFile({ type: 'image/svg+xml', size: 100 })

  const attrs = new Map([
    ['id', 'logo'],
    ['class', 'brand'],
    ['style', 'width:40px'],
    ['onclick', 'evil()'],
  ])
  const oldSvg = {
    tagName: 'svg',
    attributes: Array.from(attrs, ([name, value]) => ({ name, value })),
    ownerDocument: {
      createElement: () => ({
        attrs: new Map(),
        setAttribute(name, value) {
          this.attrs.set(name, value)
        },
        hasAttribute() {
          return false
        },
      }),
    },
    getAttribute: () => 'Brand logo',
    querySelector: () => null,
    replaceWith(next) {
      this.replacement = next
    },
  }
  const newImage = replaceImage(oldSvg, 'data:image/png;base64,AA==', { width: 40, height: 20 })
  assert.equal(imageTarget(oldSvg), oldSvg)
  assert.equal(newImage.attrs.get('id'), 'logo')
  assert.equal(newImage.attrs.get('src'), 'data:image/png;base64,AA==')
  assert.equal(newImage.attrs.get('alt'), 'Brand logo')
  assert.equal(newImage.attrs.has('onclick'), false)
})

test('manual saves are exact, revision-locked and blocked during AI jobs', () => {
  const original = '<h1>old</h1>'
  const updated = '<h1 style="color:red">new</h1>'
  const input = { revision: htmlRevision(original), html: updated }
  assert.equal(validateManualSave(input, original, false), updated)
  assert.throws(() => validateManualSave(input, updated, false), /其他窗口修改/)
  assert.throws(() => validateManualSave(input, original, true), /AI 修改进行中/)
  assert.throws(() => validateManualSave({ ...input, html: ' ' }, original, false), /为空/)
  assert.throws(() => validateManualSave({ html: updated }, original, false), /其他窗口修改/)
})

test('manual shell contains no AI overlay and exposes explicit workspace-save controls', () => {
  const html = manualEditorShell('/preview/test')
  assert.match(html, /<header><strong>手动编辑<\/strong>/)
  assert.doesNotMatch(html, /手动编辑.*不调用 AI/)
  assert.match(html, /写入AI工作区/)
  assert.match(html, /<dialog id="versionDialog"/)
  assert.match(html, /id="versionFeedback"[^>]*maxlength="500"[^>]*required/)
  assert.match(html, /版本号自动生成/)
  assert.match(html, /版本修改备注/)
  assert.match(html, /preview\/test\/__layrr__\/manual.js/)
  assert.doesNotMatch(html, /overlay.js/)
  assert.match(html, /<option value="grid">容器网格拖拽<\/option>/)
  assert.doesNotMatch(html, /<option value="reorder">|模块重排/)
  assert.match(html, /id="gridSettings" hidden/)
  assert.match(html, /id="gridSize"[^>]*value="30"/)
  assert.match(html, /id="gridAuto"[^>]*checked/)
  for (const direction of ['left', 'right', 'up', 'down'])
    assert.match(html, new RegExp(`data-sibling="${direction}" disabled`))
  for (const direction of ['left', 'right', 'up', 'down'])
    assert.match(html, new RegExp(`data-swap="${direction}" disabled`))
  assert.match(html, /id="swapSteps"[^>]*min="1"[^>]*value="1"/)
})
