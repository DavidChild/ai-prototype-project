import { prepareDocument, restoreDocument } from './prototypeDocument.js'
import { gridPosition, normalizeLayout, applyGridDocument } from './gridstack-document.js'
const $ = (id) => document.getElementById(id)
const base = location.pathname.slice(0, location.pathname.lastIndexOf('grid'))
let original,
  editable,
  scripts,
  revision,
  utilityCss = '',
  selected,
  selectedIndex,
  grid,
  items = [],
  history = [],
  cursor = -1,
  saved = '',
  busy = false,
  restoring = false
const status = (message) => {
  $('status').textContent = message
}
const parentButton = document.createElement('button')
parentButton.textContent = '选择父级容器'
parentButton.disabled = true
$('convert').before(parentButton)
function selectContainer(target) {
  if (!target || target === $('source').contentDocument.body || !target.hasAttribute('data-qp-pick')) {
    status('已到最外层，请选择具体区域，不转换整个 Body。')
    return
  }
  if (selected) selected.style.outline = ''
  selected = target
  selectedIndex = Number(target.getAttribute('data-qp-pick'))
  selected.style.outline = '3px solid #2563eb'
  $('convert').disabled = false
  parentButton.disabled = false
  status('选中 ' + target.tagName + (target.id ? '#' + target.id : '') + '，包含 ' + target.children.length + ' 个直接子节点。确认后点击转换，或选择父级容器。')
}
parentButton.onclick = () => selectContainer(selected?.parentElement)
async function request(method = 'GET', data) {
  const response = await fetch(base + '__layrr__/manual-data', {
    method,
    headers: { 'x-quickpage-manual': '1', 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '工作区请求失败')
  return result
}
function layout() {
  return normalizeLayout(grid.save(false, false, undefined, 12))
}
function update() {
  $('undo').disabled = busy || cursor <= 0
  $('redo').disabled = busy || cursor >= history.length - 1
  $('save').disabled = busy || !grid || JSON.stringify(layout()) === saved
}
function record() {
  if (restoring) return
  const snapshot = JSON.stringify(layout())
  if (history[cursor] !== snapshot) {
    history = history.slice(0, cursor + 1)
    history.push(snapshot)
    if (history.length > 60) history.shift()
    cursor = history.length - 1
  }
  update()
}
function restore(delta) {
  if (!grid || busy) return
  const next = cursor + delta
  if (next < 0 || next >= history.length) return
  cursor = next
  restoring = true
  grid.load(JSON.parse(history[cursor]), false)
  restoring = false
  update()
}
function safePreview(doc) {
  doc.querySelectorAll('script,meta[http-equiv],iframe,object,embed').forEach((n) => n.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes])
      if (
        /^on/i.test(attr.name) ||
        (/^(href|src|action)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))
      )
        el.removeAttribute(attr.name)
  })
  const style = doc.createElement('style')
  style.textContent = utilityCss
  doc.head.append(style)
  return '<!doctype html>' + doc.documentElement.outerHTML
}
function exportHtml() {
  const doc = editable.cloneNode(true)
  const container = doc.body.querySelectorAll('*')[selectedIndex]
  const mapping = items.map((item) => ({ id: item.id, node: container.children[item.index] }))
  // Already converted items are reused, not wrapped a second time.
  for (const item of mapping)
    if (item.node.hasAttribute('data-qp-grid-item')) {
      const wrapper = item.node
      item.node = wrapper.firstElementChild
      wrapper.replaceWith(item.node)
    }
  applyGridDocument(doc, container, mapping, layout())
  restoreDocument(doc, scripts)
  doc.head.querySelectorAll('[data-qp-compiled-styles]').forEach((n) => n.remove())
  if (utilityCss) {
    const style = doc.createElement('style')
    style.setAttribute('data-qp-compiled-styles', 'tailwind')
    style.textContent = utilityCss
    doc.head.append(style)
  }
  return (
    (original.doctype ? new XMLSerializer().serializeToString(original.doctype) + '\n' : '') +
    doc.documentElement.outerHTML
  )
}
try {
  const data = await request()
  revision = data.revision
  original = new DOMParser().parseFromString(data.html, 'text/html')
  editable = original.cloneNode(true)
  scripts = prepareDocument(editable)
  const response = await fetch(base + '__layrr__/visual-styles', {
      headers: { 'x-quickpage-manual': '1' },
    }),
    styles = await response.json()
  if (!response.ok || styles.revision !== revision)
    throw new Error(styles.error || '工作区已变化，请重新载入')
  utilityCss = styles.css
  const preview = editable.cloneNode(true)
  preview.body
    .querySelectorAll('*')
    .forEach((el, index) => el.setAttribute('data-qp-pick', String(index)))
  $('source').onload = () => {
    const doc = $('source').contentDocument
    doc.addEventListener(
      'click',
      (event) => {
        event.preventDefault()
        event.stopPropagation()
        let target = event.target
        while (
          target &&
          target !== doc.body &&
          (!['DIV', 'SECTION', 'MAIN', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'NAV'].includes(
            target.tagName,
          ) ||
            !target.children.length)
        )
          target = target.parentElement
        if (!target || target === doc.body) {
          status('请选择包含子模块的容器，不能直接转换整个 Body。')
          return
        }
        selectContainer(target)
      },
      true,
    )
    status('点选需要转换的布局容器，再点击转换。原页面尚未改动。')
  }
  $('source').srcdoc = safePreview(preview)
  $('convert').onclick = () => {
    try {
      const source = editable.body.querySelectorAll('*')[selectedIndex],
        bounds = selected.getBoundingClientRect()
      const children = [...source.children]
      const all = [...editable.body.querySelectorAll('*')]
      items = children
        .map((node, index) => ({
          node,
          index,
          id: 'block-' + index,
          view: selected.querySelector('[data-qp-pick="' + all.indexOf(node) + '"]'),
        }))
        .filter(
          (item) =>
            !['STYLE', 'SCRIPT', 'LINK'].includes(item.node.tagName) &&
            !item.node.hasAttribute('data-qp-script') &&
            !item.node.hidden &&
            item.view?.getBoundingClientRect().width > 0,
        )
      if (!items.length || items.length > 100)
        throw new Error('请选择包含 1–100 个可见直接子模块的容器。')
      $('canvas').style.width = Math.max(320, Math.round(bounds.width)) + 'px'
      $('canvas').hidden = false
      grid = window.GridStack.init(
        {
          column: 12,
          cellHeight: 24,
          margin: 0,
          mode: 'top',
          animate: true,
          draggable: { handle: '.card-handle' },
          resizable: { handles: 'e,se,s,sw,w' },
          columnOpts: { breakpoints: [] },
        },
        $('canvas'),
      )
      grid.batchUpdate()
      for (const item of items) {
        const rect = item.view.getBoundingClientRect()
        const position = item.node.hasAttribute('data-qp-grid-position')
          ? normalizeLayout([JSON.parse(item.node.getAttribute('data-qp-grid-position'))])[0]
          : gridPosition(rect, bounds)
        const widget = document.createElement('div')
        widget.className = 'grid-stack-item'
        const content = document.createElement('div')
        content.className = 'grid-stack-item-content'
        const handle = document.createElement('div')
        handle.className = 'card-handle'
        handle.textContent = '⠿ 模块 ' + (items.indexOf(item) + 1)
        const iframe = document.createElement('iframe')
        iframe.className = 'card-preview'
        iframe.setAttribute('sandbox', '')
        const doc = editable.cloneNode(true)
        doc.body.replaceChildren(
          doc.importNode(
            item.node.hasAttribute('data-qp-grid-item') ? item.node.firstElementChild : item.node,
            true,
          ),
        )
        const reset = doc.createElement('style')
        reset.textContent =
          'html,body{margin:0!important;padding:0!important;min-width:0!important;width:100%!important;min-height:0!important}body> :first-child{position:relative!important;inset:auto!important;width:100%!important;max-width:100%!important;min-width:0!important;margin:0!important;box-sizing:border-box!important}'
        doc.head.append(reset)
        iframe.srcdoc = safePreview(doc)
        content.append(handle, iframe)
        widget.append(content)
        $('canvas').append(widget)
        grid.makeWidget(widget, { ...position, id: item.id })
      }
      grid.batchUpdate(false)
      grid.on('change', record)
      $('source').hidden = true
      parentButton.disabled = true
      $('convert').disabled = true
      $('download').disabled = false
      record()
      status(
        '转换预览已完成：' +
          items.length +
          ' 个模块。拖动顶部移动、边缘缩放，其他模块自动避让；确认效果后再写入工作区。',
      )
    } catch (error) {
      status('转换失败：' + error.message)
    }
  }
  $('undo').onclick = () => restore(-1)
  $('redo').onclick = () => restore(1)
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      restore(event.shiftKey ? 1 : -1)
    }
  })
  $('download').onclick = () => {
    const url = URL.createObjectURL(new Blob([exportHtml()], { type: 'text/html;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'prototype-grid.html'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  $('save').onclick = async () => {
    if (!grid || busy) return
    busy = true
    update()
    try {
      const result = await request('POST', { html: exportHtml(), revision })
      revision = result.revision
      saved = JSON.stringify(layout())
      status('已写入工作区。请返回小豆原型检查并确认保存到当前迭代。')
    } catch (error) {
      status('保存失败：' + error.message)
    } finally {
      busy = false
      update()
    }
  }
} catch (error) {
  status('载入失败：' + error.message)
}
window.addEventListener('beforeunload', (event) => {
  if (grid && JSON.stringify(layout()) !== saved) {
    event.preventDefault()
    event.returnValue = ''
  }
})
