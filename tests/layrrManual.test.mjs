import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { htmlRevision, manualEditorShell, validateManualSave } from '../server/layrrManual.ts'
import { textSelection } from '../server/layrrManualText.js'
import {
  applyElementSize,
  applyFreeDrag,
  dragTranslation,
  keyboardCommand,
  moveModule,
  resizeBox,
} from '../server/layrrManualLayout.js'

test('local editing opens and reopens the original manual workspace', async () => {
  const source = await readFile(new URL('../src/components/workbench/LayrrEditor.vue', import.meta.url), 'utf8')
  assert.ok(source.includes("popup.location.href = result.url + 'manual'"))
  assert.ok(source.includes("window.open(workspace.value.url + 'manual'"))
  assert.ok(source.includes("workspace.url + 'manual'"))
  assert.match(source, /html: original/)
  assert.doesNotMatch(source, /result.editorUrl|workspace.editorUrl|tmagic-editor/)
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
  assert.match(html, /不调用 AI/)
  assert.match(html, /写入工作区/)
  assert.match(html, /preview\/test\/__layrr__\/manual.js/)
  assert.doesNotMatch(html, /overlay.js/)
})
