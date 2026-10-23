import assert from 'node:assert/strict'
import test from 'node:test'
import { gridPosition, normalizeLayout, applyGridDocument } from '../server/gridstackDocument.js'
import { gridstackEditorShell } from '../server/gridstackEditor.ts'
test('conversion maps measured modules to bounded 12-column geometry', () => {
  assert.deepEqual(
    gridPosition({ left: 100, top: 48, width: 300, height: 100 }, { left: 0, top: 0, width: 600 }),
    { x: 2, y: 2, w: 6, h: 5 },
  )
  assert.deepEqual(normalizeLayout([{ id: 'a', x: 100, y: -1, w: 20, h: 0 }]), [
    { id: 'a', x: 11, y: 0, w: 1, h: 2 },
  ])
  assert.throws(() => normalizeLayout([{ id: 'a', x: NaN, y: 1, w: 1, h: 2 }]))
})
test('grid export wraps original nodes without flattening descendants or executing scripts', () => {
  const created = []
  const doc = {
    createElement() {
      const node = {
        attrs: {},
        style: {},
        setAttribute(k, v) {
          this.attrs[k] = v
        },
        append(child) {
          this.child = child
        },
      }
      created.push(node)
      return node
    },
  }
  const child = {
    style: {},
    descendants: ['original text', 'svg'],
    replaceWith(wrapper) {
      this.wrapper = wrapper
    },
  }
  const container = {
    style: {},
    setAttribute(k, v) {
      this[k] = v
    },
  }
  applyGridDocument(
    doc,
    container,
    [{ id: 'a', node: child }],
    [{ id: 'a', x: 3, y: 2, w: 5, h: 4 }],
  )
  assert.equal(container.style.display, 'grid')
  assert.equal(created[0].child, child)
  assert.equal(created[0].attrs['data-qp-grid-item'], 'a')
  assert.match(created[0].style.cssText, /grid-column:4\/span 5/)
  assert.deepEqual(child.descendants, ['original text', 'svg'])
  assert.throws(() =>
    applyGridDocument(
      doc,
      container,
      [{ id: 'a', node: child }],
      [{ id: 'unknown', x: 0, y: 0, w: 1, h: 2 }],
    ),
  )
})
test('independent editor uses local assets, sandboxed previews and explicit save', () => {
  const html = gridstackEditorShell('/preview/test')
  assert.match(html, /sandbox="allow-same-origin"/)
  assert.match(html, /转换选中容器/)
  assert.match(html, /gridstack.js/)
  assert.match(html, /确认保存/)
  assert.doesNotMatch(html, /https:\/\//)
})
