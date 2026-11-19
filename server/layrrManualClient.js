// Served only inside the isolated local workspace, never stored in prototype HTML.
import { textSelection } from './manual-text.js'
import { imageTarget, imageUrl, validateImageFile, replaceImage } from './manual-image.js'
import { moveModule, keyboardCommand, dragTranslation, applyFreeDrag, resizeBox, applyElementSize, applyElementDimension, normalizeGridStep, automaticGridStep, nthDirectionalSibling, siblingSwapTranslations, applyChildLayout, groupChildLayoutRows, childRowLayoutOffsets } from './manual-layout.js'
import { recordDomChanges, applyDomChanges } from './manual-history.js'
const base = location.pathname.slice(0, location.pathname.lastIndexOf('manual'))
const $ = (id) => document.getElementById(id)
const frame = $('canvas')
const inspectorTabs = Array.from(document.querySelectorAll('.editor-tabs [role="tab"]'))
function setInspectorTab(id) {
  for (const tab of inspectorTabs) {
    const active = tab.id === id
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
    $(tab.getAttribute('aria-controls')).hidden = !active
  }
}
for (const [index, tab] of inspectorTabs.entries()) {
  tab.onclick = () => setInspectorTab(tab.id)
  tab.onkeydown = (event) => {
    const next = {
      ArrowLeft: (index + inspectorTabs.length - 1) % inspectorTabs.length,
      ArrowRight: (index + 1) % inspectorTabs.length,
      Home: 0,
      End: inspectorTabs.length - 1,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    setInspectorTab(inspectorTabs[next].id)
    inspectorTabs[next].focus({ preventScroll: true })
  }
}
let source,
  revision,
  saved,
  selected,
  selectedKey,
  busy = false,
  ready = false
let scrollPosition = { x: 0, y: 0 }
let nodes = new Map(),
  history = [],
  position = -1
const marker = 'data-quickpage-manual-node'
let nextKey = 0,
  nodeKeys = new WeakMap(),
  liveNodes = new WeakMap()
let interaction,
  directInteraction,
  gesture = null,
  suppressClick = false
let imageRequest = 0,
  imagePending = false
let pendingSubmission = null
let retrySubmission = null
let childLayoutRowSignature = ''
let selectedTextIndex = -1
function keyFor(node) {
  return node && nodeKeys.get(node)
}
function positionDragMode() {
  return $('dragMode').value !== 'reorder'
}
function dragHandleLabel() {
  return { free: '自由拖动', parent: '父容器内拖拽', grid: '容器网格拖拽' }[$('dragMode').value]
}
function gridStep() {
  return normalizeGridStep($('gridSize').value)
}
function syncGridStep(live) {
  if (gesture || !$('gridAuto').checked || !live?.parentElement) return
  const next = String(automaticGridStep(frame.contentWindow.getComputedStyle(live.parentElement)))
  if ($('gridSize').value === next) return
  $('gridSize').value = next
  if ($('dragMode').value === 'grid') status(`容器网格拖拽：自动步长 ${next}px，限制在父容器内`)
}
function dragOptions(handle = false) {
  const mode = $('dragMode').value
  const snapped = mode === 'grid'
  const constrained = mode === 'parent' || snapped
  const modifiers = []
  if (snapped) {
    let step, snap
    modifiers.push(window.interact.modifiers.snap({
      // Read the current setting even when a new element is selected at dragstart.
      targets: [(x, y) => {
        const current = gridStep()
        if (current !== step) {
          step = current
          snap = window.interact.snappers.grid({ x: step, y: step })
        }
        return snap(x, y)
      }],
      range: Infinity,
      relativePoints: [{ x: 0, y: 0 }],
    }))
  }
  if (constrained)
    modifiers.push(window.interact.modifiers.restrictRect({
      restriction: handle
        ? () => (gesture?.live || frame.contentDocument.querySelector('[' + marker + '="' + selectedKey + '"]'))?.parentElement
        : 'parent',
      endOnly: true,
    }))
  return {
    // Do not resume an inertial gesture with a new pointer: one gesture is one
    // source/history commit, after the final restriction correction has settled.
    inertia: constrained ? { allowResume: false } : false,
    modifiers,
    autoScroll: { container: frame.contentWindow, margin: 35, speed: 300 },
  }
}
function registerNodes() {
  for (const node of [source.documentElement, ...source.documentElement.querySelectorAll('*')]) {
    if (!nodeKeys.has(node)) {
      const key = String(nextKey++)
      nodeKeys.set(node, key)
      nodes.set(key, node)
    }
  }
}
function liveFor(node) {
  let live = liveNodes.get(node)
  if (live) return live
  // importNode does not execute inserted scripts. Restore the existing nodes
  // whenever possible instead of recreating media, listeners or nested frames.
  live = frame.contentDocument.importNode(node, false)
  liveNodes.set(node, live)
  if (node.nodeType === 1) live.setAttribute(marker, keyFor(node))
  for (const child of node.childNodes) live.appendChild(liveFor(child))
  return live
}
function refreshSelection(key) {
  const node = nodes.get(key)
  if (node && source.documentElement.contains(node)) select(key)
  else {
    imageRequest++
    selected = null
    selectedKey = null
    $('props').hidden = true
    $('selection').textContent = '点击选择元素；直接拖动或使用“自由拖动”手柄移动。'
    const highlight = frame.contentDocument.getElementById('qp-manual-highlight')
    if (highlight) highlight.style.display = 'none'
  }
}
const blockedTags = new Set([
  'HTML',
  'BODY',
  'HEAD',
  'SCRIPT',
  'STYLE',
  'LINK',
  'META',
  'TEMPLATE',
  'NOSCRIPT',
])
function selectable(el) {
  return el && !blockedTags.has(el.tagName)
}
function attributeTargets() {
  if (!selected || !source?.body?.contains(selected)) return []
  if (!$('scopeSimilar').checked) return [selected]
  const classes = Array.from(selected.classList).sort().join('\0')
  return Array.from(source.body.getElementsByTagName(selected.tagName)).filter((element) =>
    element.namespaceURI === selected.namespaceURI &&
    Array.from(element.classList).sort().join('\0') === classes,
  )
}
function updateAttributeScope() {
  const locked = busy || !!gesture || !ready || imagePending
  $('scopeSingle').disabled = $('scopeSimilar').disabled = locked || !selected
  document.querySelectorAll('[data-nudge]').forEach((button) => {
    button.disabled = busy || !ready || imagePending || !selected || !!gesture && gesture.kind !== 'nudge'
  })
  const similar = $('scopeSimilar').checked && !!selected
  $('attributeScopeDetails').hidden = !similar
  if (!similar) {
    $('attributeScopeHint').textContent = '仅修改当前选中元素。'
    return
  }
  const classes = Array.from(selected.classList).sort()
  $('attributeScopeHint').textContent = `将应用到 ${attributeTargets().length} 个类似元素（含当前元素）`
  $('attributeScopeTag').textContent = selected.localName
  const classText = classes.length ? classes.join('\n') : '无 class'
  if ($('attributeScopeClasses').textContent !== classText) $('attributeScopeClasses').textContent = classText
}
function commitAttributes(action, targets = attributeTargets(), skipped = 0) {
  if (!ready || busy || gesture || !targets.length) return
  if (commit(() => targets.forEach(action)) && $('scopeSimilar').checked)
    status(`已应用到 ${targets.length} 个类似元素${skipped ? `；跳过 ${skipped} 个不可编辑文字的元素` : ''}，尚未写入工作区`)
}
function siblingContext() {
  if (!selected?.parentElement || !ready) return null
  const live = liveNodes.get(selected)
  if (!live?.isConnected) return null
  const candidates = []
  for (const sibling of selected.parentElement.children) {
    if (sibling === selected || !selectable(sibling)) continue
    const element = liveNodes.get(sibling)
    if (!element?.isConnected) continue
    const visibility = frame.contentWindow.getComputedStyle(element).visibility
    if (visibility === 'hidden' || visibility === 'collapse') continue
    candidates.push({ key: keyFor(sibling), rect: element.getBoundingClientRect() })
  }
  return { rect: live.getBoundingClientRect(), candidates }
}
function siblingKey(direction, count = 1, context = siblingContext()) {
  return context ? nthDirectionalSibling(context.rect, context.candidates, direction, count) : null
}
function swapCount() {
  const value = Number($('swapSteps').value)
  return Number.isFinite(value) ? Math.min(999, Math.max(1, Math.floor(value))) : 1
}
function updateSiblingButtons() {
  const locked = busy || !!gesture || !ready
  const context = !locked && siblingContext()
  $('swapSteps').disabled = locked || !selected
  document.querySelectorAll('[data-sibling]').forEach((button) => {
    button.disabled = locked || !siblingKey(button.dataset.sibling, 1, context)
  })
  document.querySelectorAll('[data-swap]').forEach((button) => {
    button.disabled = locked || !siblingKey(button.dataset.swap, swapCount(), context)
  })
}
function numericLayer(value) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}
function elementLayer(element = selected) {
  if (!element) return 0
  const live = liveNodes.get(element)
  return numericLayer(live?.isConnected
    ? frame.contentWindow.getComputedStyle(live).zIndex
    : element.style.getPropertyValue('z-index'))
}
function siblingLayers() {
  if (!selected?.parentElement) return [elementLayer()]
  return Array.from(selected.parentElement.children)
    .filter(selectable)
    .map((element) => elementLayer(element))
}
function updateLayerControls() {
  const locked = busy || !!gesture || !ready || !selected
  $('zIndex').disabled = locked
  document.querySelectorAll('[data-layer]').forEach((button) => { button.disabled = locked })
  if (!locked && document.activeElement !== $('zIndex')) $('zIndex').value = String(elementLayer())
}
function setElementLayer(value) {
  if (!selected || !ready || busy || gesture || !Number.isInteger(value)) return
  const target = selected
  commit(() => target.style.setProperty('z-index', String(value), 'important'))
}
function childLayoutItems(container) {
  return Array.from(container.children).filter(selectable).map((node) => {
    const live = liveNodes.get(node)
    if (!live?.isConnected) return null
    const style = frame.contentWindow.getComputedStyle(live)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return null
    return { node, live, key: keyFor(node), rect: live.getBoundingClientRect() }
  }).filter(Boolean)
}
function childLayoutRows() {
  if (!selected || !ready) return []
  const rows = []
  for (const items of groupChildLayoutRows(childLayoutItems(selected))) {
    // A common prototype structure is container > ul/div > li/items. Treat a
    // single visual wrapper as the row container instead of asking the user
    // to distribute that one wrapper. This keeps the row choice meaningful.
    if (items.length === 1) {
      const wrapper = items[0].node
      const nested = childLayoutItems(wrapper)
      if (nested.length >= 2) {
        for (const nestedRow of groupChildLayoutRows(nested))
          rows.push({ items: nestedRow, container: wrapper, wrapped: true })
        continue
      }
    }
    rows.push({ items, container: selected, wrapped: false })
  }
  return rows
}
function selectedChildLayoutRow(rows) {
  if (rows.length <= 1) return rows[0] || null
  const index = Number($('childLayoutRow').value)
  return Number.isInteger(index) && index >= 0 && index < rows.length ? rows[index] : null
}
function updateChildLayoutRowPicker(rows) {
  const picker = $('childLayoutRowPicker'), select = $('childLayoutRow')
  picker.hidden = rows.length <= 1
  if (rows.length <= 1) {
    childLayoutRowSignature = ''
    select.replaceChildren()
    return
  }
  const signature = selectedKey + ':' + rows.map((row) => row.items.map(({ key }) => key).join(',')).join('|')
  if (signature === childLayoutRowSignature) return
  childLayoutRowSignature = signature
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = '请选择需要调整的行…'
  select.replaceChildren(placeholder)
  rows.forEach(({ items, wrapped }, index) => {
    const option = document.createElement('option')
    option.value = String(index)
    const names = items.slice(0, 3).map(({ node }) => node.id ? '#' + node.id : node.tagName.toLowerCase()).join('、')
    option.textContent = `第 ${index + 1} 行 · ${items.length} 个元素${wrapped ? '（已进入包裹层）' : ''}${names ? ` · ${names}${items.length > 3 ? '…' : ''}` : ''}`
    select.append(option)
  })
}
function updateChildLayoutControls() {
  const rows = childLayoutRows()
  updateChildLayoutRowPicker(rows)
  const row = selectedChildLayoutRow(rows)
  const children = row?.items || []
  const locked = busy || !!gesture || !ready
  document.querySelectorAll('[data-child-layout]').forEach((button) => {
    button.disabled = locked || !children.length || button.dataset.childLayout === 'horizontal' && children.length < 2
  })
  document.querySelectorAll('[name="childEdgeMode"]').forEach((input) => {
    // Keep the layout preference editable even when the current container
    // cannot run horizontal distribution. The button itself communicates
    // whether the selected container has enough direct children.
    input.disabled = locked
  })
  $('childLayoutRow').disabled = locked || rows.length <= 1
  const total = rows.reduce((count, row) => count + row.items.length, 0)
  $('childLayoutHint').textContent = rows.length > 1 && !children.length
    ? `检测到 ${rows.length} 行、共 ${total} 个直接子元素，请先手动选择需要调整的行。`
    : children.length
      ? `${rows.length > 1 ? `已选择第 ${Number($('childLayoutRow').value) + 1} 行，` : '当前容器'}包含 ${children.length} 个可排列元素${row?.wrapped ? '（已自动进入包裹层）' : ''}${children.length < 2 ? '；水平等距至少需要 2 个' : ''}。`
      : '请选择包含直接子元素的容器。'
}
function childLayoutContentBounds(container = selected) {
  const live = liveNodes.get(container)
  if (!live?.isConnected) throw new Error('容器已改变，请重新选择')
  const rect = live.getBoundingClientRect(), style = frame.contentWindow.getComputedStyle(live)
  const number = (name) => Number.parseFloat(style.getPropertyValue(name)) || 0
  return {
    left: rect.left + number('border-left-width') + number('padding-left'),
    right: rect.right - number('border-right-width') - number('padding-right'),
  }
}
function applyChildLayoutRow(row, action, edgeMode) {
  const planned = childRowLayoutOffsets(row.items, action, edgeMode, childLayoutContentBounds(row.container)).map(({ item, dx, dy }) => {
    const state = elementPositionState(item.live), { inverse } = state
    return {
      node: item.node, inline: state.inline,
      value: dragTranslation(state.translate, inverse.a * dx + inverse.c * dy, inverse.b * dx + inverse.d * dy),
    }
  })
  return commit(() => planned.forEach(({ node, value, inline }) => applyFreeDrag(node, value, inline)), selectedKey)
}
function status(message, error = false) {
  $('status').textContent = message
  $('status').dataset.error = String(error)
}
function serialize() {
  const dt = source.doctype
  return (
    (dt ? new XMLSerializer().serializeToString(dt) + '\n' : '') + source.documentElement.outerHTML
  )
}
function update() {
  const locked = busy || !!gesture
  $('dragMode').disabled = locked || !ready
  $('gridSettings').hidden = $('dragMode').value !== 'grid'
  $('gridSize').disabled = locked || !ready || $('dragMode').value !== 'grid'
  $('gridAuto').disabled = $('gridSize').disabled
  updateSiblingButtons()
  updateLayerControls()
  updateChildLayoutControls()
  updateAttributeScope()
  $('undo').disabled = locked || position <= 0
  $('redo').disabled = locked || position >= history.length - 1
  $('save').disabled = locked || !ready || serialize() === saved
  $('dirty').textContent = pendingSubmission ? '正在保存版本…' : ready
    ? serialize() === saved
      ? '工作区已同步'
      : '有未写入修改'
    : '正在载入'
}
function render(key) {
  imageRequest++
  if (ready) scrollPosition = { x: frame.contentWindow.scrollX, y: frame.contentWindow.scrollY }
  interaction?.unset()
  directInteraction?.unset()
  directInteraction = null
  interaction = null
  gesture = null
  ready = false
  selected = null
  selectedKey = key
  $('props').hidden = true
  $('selection').textContent = '点击选择元素；直接拖动或使用“自由拖动”手柄移动。'
  const clone = source.documentElement.cloneNode(true)
  registerNodes()
  const originals = [source.documentElement, ...source.documentElement.querySelectorAll('*')]
  const copies = [clone, ...clone.querySelectorAll('*')]
  originals.forEach((el, i) => {
    copies[i].setAttribute(marker, keyFor(el))
  })
  frame.srcdoc = '<!doctype html>' + clone.outerHTML
  update()
}
function commit(action, key = selectedKey) {
  if (!ready || busy) return false
  const beforeKey = selectedKey
  const changes = recordDomChanges(source.documentElement, action)
  const html = serialize()
  if (html === history[position].html) return false
  registerNodes()
  const afterKey = typeof key === 'function' ? keyFor(key()) : key
  applyDomChanges(changes, 'after', liveFor)
  history = history.slice(0, position + 1)
  history.push({ html, changes, beforeKey, afterKey })
  if (history.length > 60) history.shift()
  position = history.length - 1
  refreshSelection(afterKey)
  update()
  status('修改已预览，尚未写入工作区')
  return true
}
function editableText(el) {
  return textSelection(el).editable
}
function select(key) {
  let el = nodes.get(key)
  const image = imageTarget(el)
  if (image && image !== el) {
    key = Array.from(nodes).find(([, node]) => node === image)?.[0]
    el = image
  }
  if (!selectable(el)) return
  if (gesture?.kind === 'nudge' && selected !== el) finishNudge()
  const sameSelection = selected === el
  if (!sameSelection) selectedTextIndex = -1
  if (selected !== el) imageRequest++
  selected = el
  selectedKey = key
  const live = frame.contentDocument.querySelector('[' + marker + '="' + key + '"]')
  if (!live) return
  syncGridStep(live)
  updateSiblingButtons()
  updateLayerControls()
  updateChildLayoutControls()
  updateAttributeScope()
  const style = frame.contentWindow.getComputedStyle(live)
  $('props').hidden = false
  $('childPicker').hidden = true
  $('children').replaceChildren()
  $('parent').disabled = !selectable(el.parentElement)
  const children = Array.from(el.children).filter(selectable)
  $('child').disabled = children.length === 0
  $('child').title = children.length ? '选择当前元素的直接子元素' : '当前元素没有可选择的子元素'
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = '请选择子元素…'
  $('children').append(placeholder)
  children.forEach((child, index) => {
    const key = Array.from(nodes).find(([, node]) => node === child)?.[0]
    if (key === undefined) return
    const option = document.createElement('option')
    option.value = key
    const text = child.textContent?.replace(/\s+/g, ' ').trim().slice(0, 32)
    option.textContent =
      index +
      1 +
      '. ' +
      child.tagName.toLowerCase() +
      (child.id ? '#' + child.id : '') +
      (text ? ' · ' + text : '')
    $('children').append(option)
  })
  $('selection').textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
  $('imageEditor').hidden = !image
  $('imageFile').value = ''
  const imageSrc = image?.getAttribute('src') || ''
  $('imageUrl').value = /^https?:/.test(imageSrc) ? imageSrc : ''
  $('imageHint').textContent =
    image?.tagName.toLowerCase() === 'svg'
      ? '替换后转换为图片，保留原有尺寸与样式；可撤销恢复 SVG。'
      : '替换后可撤销，不调用 AI。'
  const summary = textSelection(el, -1)
  const text = textSelection(el, selectedTextIndex)
  const textSegment = $('textSegment')
  textSegment.replaceChildren()
  textSegment.hidden = summary.segments.length < 2
  summary.segments.forEach((segment) => {
    const option = document.createElement('option')
    option.value = String(segment.index)
    option.textContent = segment.label
    textSegment.append(option)
  })
  if (selectedTextIndex >= 0 && !summary.segments.some((segment) => segment.index === selectedTextIndex))
    selectedTextIndex = -1
  if (textSegment.hidden) selectedTextIndex = -1
  else textSegment.value = String(selectedTextIndex)
  const canEditText = editableText(el) || selectedTextIndex >= 0 && text.editable
  if (!sameSelection || document.activeElement !== $('text')) $('text').value = text.value
  $('text').disabled = $('applyText').disabled = !canEditText
  $('textHint').textContent = canEditText
    ? '仅修改选中的文字片段，保留其他文字、图标和内部标签。'
    : summary.segments.length > 1
      ? '请选择要修改的文字片段；只会替换该段文字，不影响其他 HTML 子元素。'
      : '未找到可编辑文字，请选择具体文字元素。'
  document.querySelectorAll('[data-style]').forEach((input) => {
    const property = input.dataset.style
    if (sameSelection && document.activeElement === input) return
    if (input.type === 'color') {
      const rgb = style.getPropertyValue(property).match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/)
      input.value = rgb
        ? '#' +
          rgb
            .slice(1)
            .map((n) => Number(n).toString(16).padStart(2, '0'))
            .join('')
        : '#ffffff'
    } else {
      input.value = el.style.getPropertyValue(property)
      input.placeholder = style.getPropertyValue(property)
    }
  })
  let highlight = frame.contentDocument.getElementById('qp-manual-highlight')
  if (!highlight) {
    highlight = frame.contentDocument.createElement('div')
    highlight.id = 'qp-manual-highlight'
    highlight.style.cssText =
      'position:fixed;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.06);z-index:2147483647;box-sizing:border-box;touch-action:none'
    frame.contentDocument.body.append(highlight)
    const handle = frame.contentDocument.createElement('button')
    handle.textContent = dragHandleLabel()
    handle.dataset.move = '1'
    handle.style.cssText =
      'position:absolute;top:-27px;left:-2px;height:25px;background:#2563eb;color:white;border:0;border-radius:4px;font:12px system-ui;pointer-events:auto;cursor:move;touch-action:none;white-space:nowrap'
    highlight.append(handle)
    for (const [name, left, top, cursor] of [
      ['nw', '-5px', '-5px', 'nwse-resize'],
      ['ne', 'calc(100% - 5px)', '-5px', 'nesw-resize'],
      ['sw', '-5px', 'calc(100% - 5px)', 'nesw-resize'],
      ['se', 'calc(100% - 5px)', 'calc(100% - 5px)', 'nwse-resize'],
      ['n', 'calc(50% - 5px)', '-5px', 'ns-resize'],
      ['s', 'calc(50% - 5px)', 'calc(100% - 5px)', 'ns-resize'],
      ['w', '-5px', 'calc(50% - 5px)', 'ew-resize'],
      ['e', 'calc(100% - 5px)', 'calc(50% - 5px)', 'ew-resize'],
    ]) {
      const grip = frame.contentDocument.createElement('span')
      grip.dataset.corner = name
      grip.style.cssText =
        'position:absolute;width:10px;height:10px;background:white;border:1px solid #2563eb;pointer-events:auto;touch-action:none'
      Object.assign(grip.style, { left, top, cursor })
      highlight.append(grip)
    }
    attachInteraction(highlight)
  }
  const rect = live.getBoundingClientRect()
  highlight.querySelector('[data-move]').style.top = rect.top < 28 ? '2px' : '-27px'
  Object.assign(highlight.style, {
    display: '',
    borderColor: '#2563eb',
    left: rect.left + 'px',
    top: rect.top + 'px',
    width: rect.width + 'px',
    height: rect.height + 'px',
  })
}
function positionHighlight(live) {
  const highlight = frame.contentDocument.getElementById('qp-manual-highlight')
  if (!highlight || !live) return
  const rect = live.getBoundingClientRect()
  highlight.querySelector('[data-move]').style.top = rect.top < 28 ? '2px' : '-27px'
  Object.assign(highlight.style, {
    left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
  })
}
function elementPositionState(live) {
  const style = frame.contentWindow.getComputedStyle(live)
  // Pointer movement is in viewport pixels; translate uses the parent's axes.
  let matrix = new frame.contentWindow.DOMMatrix()
  for (let parent = live.parentElement; parent; parent = parent.parentElement) {
    const transform = frame.contentWindow.getComputedStyle(parent).transform
    if (transform && transform !== 'none')
      matrix = new frame.contentWindow.DOMMatrix(transform).multiply(matrix)
  }
  const inverse = matrix.inverse()
  if (![inverse.a, inverse.b, inverse.c, inverse.d].every(Number.isFinite))
    throw new Error('该元素的父级使用了不可逆变换，无法移动')
  return { translate: style.translate, inline: style.display === 'inline', inverse, rect: live.getBoundingClientRect() }
}
const nudgeDirections = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }
function startNudge(button, direction, inputKind, token) {
  if (!ready || busy || gesture || imagePending || !selected || !nudgeDirections[direction]) return false
  const targets = attributeTargets(), targetSet = new Set(targets)
  let records
  try {
    records = targets.filter((element) => {
      // Descendants already inherit a matched ancestor's viewport displacement.
      for (let parent = element.parentElement; parent; parent = parent.parentElement)
        if (targetSet.has(parent)) return false
      return true
    }).map((node) => {
      const live = liveNodes.get(node)
      if (!live?.isConnected) throw new Error('元素已改变，请重新选择后微调')
      return { node, live, originalStyle: live.getAttribute('style'), ...elementPositionState(live) }
    })
  } catch (error) {
    status(error.message, true)
    return false
  }
  if (!records.length) return false
  const action = gesture = {
    kind: 'nudge', records, key: selectedKey, button, direction, inputKind, token,
    count: targets.length, dx: 0, dy: 0, moved: false,
  }
  button.dataset.holding = 'true'
  update()
  stepNudge()
  action.delay = setTimeout(() => {
    if (gesture !== action) return
    stepNudge()
    if (gesture === action) action.repeat = setInterval(stepNudge, 40)
  }, 300)
  return gesture === action
}
function stepNudge() {
  const action = gesture
  if (action?.kind !== 'nudge') return
  if (!ready || busy || action.records.some(({ node, live }) => !source.body.contains(node) || !live.isConnected)) {
    finishNudge()
    return
  }
  const [dx, dy] = nudgeDirections[action.direction]
  action.dx += dx
  action.dy += dy
  for (const record of action.records) {
    const { inverse } = record
    record.value = dragTranslation(record.translate,
      inverse.a * action.dx + inverse.c * action.dy,
      inverse.b * action.dx + inverse.d * action.dy)
    applyFreeDrag(record.live, record.value, record.inline)
  }
  action.moved = true
  positionHighlight(liveNodes.get(selected))
  status(`位置微调：${action.count} 个元素，X ${action.dx}px / Y ${action.dy}px`)
}
function finishNudge() {
  const action = gesture
  if (action?.kind !== 'nudge') return
  clearTimeout(action.delay)
  clearInterval(action.repeat)
  gesture = null
  delete action.button.dataset.holding
  if (action.inputKind === 'pointer' && action.button.hasPointerCapture(action.token))
    action.button.releasePointerCapture(action.token)
  let committed = false
  try {
    if (action.moved && ready && !busy)
      committed = commit(() => {
        for (const record of action.records) applyFreeDrag(record.node, record.value, record.inline)
      }, action.key)
    if (committed)
      status(`已微调 ${action.count} 个元素：X ${action.dx}px / Y ${action.dy}px，尚未写入AI工作区`)
  } finally {
    if (!committed)
      for (const { live, originalStyle } of action.records) {
        if (originalStyle === null) live.removeAttribute('style')
        else live.setAttribute('style', originalStyle)
      }
    if (ready) positionHighlight(liveNodes.get(selected))
    update()
  }
}
document.querySelectorAll('[data-nudge]').forEach((button) => {
  button.onpointerdown = (event) => {
    if (event.button !== 0 || event.isPrimary === false) return
    event.preventDefault()
    button.focus({ preventScroll: true })
    if (startNudge(button, button.dataset.nudge, 'pointer', event.pointerId))
      button.setPointerCapture(event.pointerId)
  }
  button.onlostpointercapture = (event) => {
    if (gesture?.kind === 'nudge' && gesture.inputKind === 'pointer' && gesture.token === event.pointerId)
      finishNudge()
  }
  button.onkeydown = (event) => {
    const direction = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[event.key] ||
      ([' ', 'Enter'].includes(event.key) ? button.dataset.nudge : null)
    if (!direction) return
    event.preventDefault()
    if (!event.repeat) startNudge(button, direction, 'keyboard', event.key)
  }
  button.onkeyup = (event) => {
    if (gesture?.kind === 'nudge' && gesture.inputKind === 'keyboard' && gesture.token === event.key) {
      event.preventDefault()
      finishNudge()
    }
  }
  button.onblur = () => {
    if (gesture?.kind === 'nudge' && gesture.button === button) finishNudge()
  }
  // Assistive technology can activate buttons without pointer or key events.
  button.onclick = (event) => {
    event.preventDefault()
    if (event.detail === 0 && !event.pointerType && startNudge(button, button.dataset.nudge, 'click')) finishNudge()
  }
})
for (const type of ['pointerup', 'pointercancel'])
  window.addEventListener(type, (event) => {
    if (gesture?.kind === 'nudge' && gesture.inputKind === 'pointer' && gesture.token === event.pointerId)
      finishNudge()
  }, true)
window.addEventListener('blur', finishNudge)
document.addEventListener('visibilitychange', () => { if (document.hidden) finishNudge() })
function startFreeDrag(key = selectedKey) {
  if (!ready || busy || gesture || !selectable(nodes.get(key))) return false
  select(key)
  const live = frame.contentDocument.querySelector('[' + marker + '="' + selectedKey + '"]')
  if (!live || !selected) return false
  let state
  try { state = elementPositionState(live) }
  catch (error) { status(error.message, true); return false }
  gesture = {
    kind: 'free', node: selected, key: selectedKey, live,
    ...state, dx: 0, dy: 0, moved: false,
  }
  suppressClick = true
  update()
  return true
}
function moveFreeDrag(event) {
  if (gesture?.kind !== 'free') return
  const { inverse } = gesture
  gesture.dx += inverse.a * event.dx + inverse.c * event.dy
  gesture.dy += inverse.b * event.dx + inverse.d * event.dy
  gesture.moved = Math.abs(gesture.dx) + Math.abs(gesture.dy) > 0.1
  gesture.value = dragTranslation(gesture.translate, gesture.dx, gesture.dy)
  applyFreeDrag(gesture.live, gesture.value, gesture.inline)
  positionHighlight(gesture.live)
  const modeLabel = { parent: '父容器内移动', grid: `容器网格移动（${gridStep()}px）`, free: '自由移动' }[$('dragMode').value]
  status(`${modeLabel}：X ${Math.round(gesture.dx)}px / Y ${Math.round(gesture.dy)}px；拖动结束后更新原型代码`)
}
function endFreeDrag() {
  const action = gesture
  gesture = null
  if (action?.kind === 'free' && action.moved && ready && !busy) {
    commit(
      () => applyFreeDrag(action.node, action.value, action.inline),
      () => action.node,
    )
  } else if (ready && selectedKey) select(selectedKey)
  update()
  setTimeout(() => { suppressClick = false }, 0)
}
function attachDirectDrag(doc) {
  if (!window.interact) return
  directInteraction = window.interact('body [' + marker + ']', { context: doc })
    .styleCursor(false)
    .draggable({
      enabled: positionDragMode(),
      ...dragOptions(),
      listeners: {
        start(event) {
          if (!startFreeDrag(event.target.getAttribute(marker))) event.interaction.stop()
        },
        move: moveFreeDrag,
        end: endFreeDrag,
      },
    })
}
function attachInteraction(highlight) {
  if (!window.interact) {
    status('拖拽组件未加载，请重新打开工作区', true)
    return
  }
  const doc = frame.contentDocument
  let indicator
  function clearDrop() {
    indicator?.remove()
    indicator = null
  }
  function showDrop(rect, placement) {
    clearDrop()
    indicator = doc.createElement('div')
    indicator.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;background:rgba(22,163,74,.15);border:2px solid #16a34a;box-sizing:border-box'
    Object.assign(indicator.style, {
      left: rect.left + 'px',
      width: rect.width + 'px',
      top: (placement === 'after' ? rect.bottom : rect.top) + 'px',
      height: (placement === 'inside' ? rect.height : 4) + 'px',
    })
    doc.body.append(indicator)
  }
  interaction = window
    .interact(highlight, { context: doc })
    .draggable({
      allowFrom: '[data-move]',
      ...dragOptions(true),
      listeners: {
        start(event) {
          if (positionDragMode()) {
            if (!startFreeDrag()) event.interaction.stop()
            return
          }
          if (!ready || busy || gesture) { event.interaction.stop(); return }
          gesture = { node: selected, key: selectedKey, target: null, placement: null }
          suppressClick = true
          update()
        },
        move(event) {
          if (gesture?.kind === 'free') { moveFreeDrag(event); return }
          if (!gesture) return
          const x = event.client.x,
            y = event.client.y
          const hit = doc.elementFromPoint(x, y)?.closest('[' + marker + ']')
          const target = nodes.get(hit?.getAttribute(marker))
          if (
            !target ||
            !selectable(target) ||
            target === gesture.node ||
            gesture.node.contains(target)
          ) {
            gesture.target = null
            clearDrop()
            status('移动到其他模块的上部/下部，或容器中央')
            return
          }
          const rect = hit.getBoundingClientRect(),
            ratio = (y - rect.top) / Math.max(rect.height, 1)
          const placement = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside'
          gesture.target = target
          gesture.placement = placement
          showDrop(rect, placement)
          status(
            '松开后放到 ' +
              target.tagName.toLowerCase() +
              (target.id ? '#' + target.id : '') +
              { before: ' 前面', after: ' 后面', inside: ' 内部末尾' }[placement],
          )
          highlight.style.borderColor = '#16a34a'
        },
        end() {
          if (gesture?.kind === 'free') { endFreeDrag(); return }
          const action = gesture
          gesture = null
          clearDrop()
          if (action?.target && !busy && ready) {
            try {
              commit(
                () => moveModule(action.node, action.target, action.placement),
                () => action.node,
              )
            } catch (error) {
              status(error.message, true)
            }
          }
          if (ready && selectedKey) select(selectedKey)
          update()
          setTimeout(() => {
            suppressClick = false
          }, 0)
        },
      },
    })
    .resizable({
      inertia: false,
      invert: 'none',
      edges: {
        left: '[data-corner="nw"],[data-corner="sw"],[data-corner="w"]',
        right: '[data-corner="ne"],[data-corner="se"],[data-corner="e"]',
        top: '[data-corner="nw"],[data-corner="ne"],[data-corner="n"]',
        bottom: '[data-corner="sw"],[data-corner="se"],[data-corner="s"]',
      },
      listeners: {
        start(event) {
          if (!ready || busy || gesture || !selected) { event.interaction.stop(); return }
          const live = doc.querySelector('[' + marker + '="' + selectedKey + '"]')
          const style = frame.contentWindow.getComputedStyle(live)
          const rect = live.getBoundingClientRect()
          const width = live.offsetWidth || rect.width
          const height = live.offsetHeight || rect.height
          gesture = {
            kind: 'resize',
            node: selected,
            live,
            initial: { width, height },
            rect: { width: event.rect.width, height: event.rect.height },
            scaleX: rect.width / Math.max(1, width),
            scaleY: rect.height / Math.max(1, height),
            translate: style.translate,
            inline: style.display === 'inline',
            moved: false,
          }
          suppressClick = true
          update()
        },
        move(event) {
          if (gesture?.kind !== 'resize') return
          gesture.moved = true
          gesture.box = resizeBox(gesture.initial, {
            width: (event.rect.width - gesture.rect.width) / gesture.scaleX,
            height: (event.rect.height - gesture.rect.height) / gesture.scaleY,
          }, event.edges)
          gesture.value = dragTranslation(gesture.translate, gesture.box.dx, gesture.box.dy)
          applyElementSize(gesture.live, gesture.box, gesture.inline)
          applyFreeDrag(gesture.live, gesture.value)
          positionHighlight(gesture.live)
          status(`调整尺寸：${Math.round(gesture.box.width)} × ${Math.round(gesture.box.height)}px；松开后更新原型代码`)
        },
        end() {
          const action = gesture
          gesture = null
          if (action?.moved && ready && !busy)
            commit(
              () => {
                applyElementSize(action.node, action.box, action.inline)
                applyFreeDrag(action.node, action.value)
              },
              () => action.node,
            )
          update()
          setTimeout(() => {
            suppressClick = false
          }, 0)
        },
      },
    })
}
function shortcut(event) {
  const command = keyboardCommand(event)
  if (!command || !ready || busy || gesture) return
  if (command === 'delete' && !selected) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (command === 'delete') $('delete').click()
  else restore(command === 'undo' ? -1 : 1)
}
document.addEventListener('keydown', shortcut, true)
frame.addEventListener('load', () => {
  if (!source) return
  ready = true
  const doc = frame.contentDocument
  liveNodes = new WeakMap()
  // Bind only original nodes, before adding editor-only overlays/styles.
  function bind(original, live) {
    if (!live) return
    liveNodes.set(original, live)
    Array.from(original.childNodes).forEach((child, index) => {
      const copy = child.nodeType === 1
        ? doc.querySelector('[' + marker + '="' + keyFor(child) + '"]')
        : live.childNodes[index]
      if (copy?.nodeType === child.nodeType) bind(child, copy)
    })
  }
  bind(source.documentElement, doc.documentElement)
  frame.contentWindow.scrollTo(scrollPosition.x, scrollPosition.y)
  // Interaction-only CSS belongs to the preview, never to source/exported HTML.
  const interactionStyle = doc.createElement('style')
  interactionStyle.textContent =
    'html[data-qp-free-drag] body *{touch-action:none!important;user-select:none!important;-webkit-user-drag:none!important}'
  doc.head.append(interactionStyle)
  doc.documentElement.toggleAttribute('data-qp-free-drag', positionDragMode())
  attachDirectDrag(doc)
  doc.addEventListener('dragstart', (event) => event.preventDefault(), true)
  doc.addEventListener('keydown', shortcut, true)
  doc.addEventListener(
    'click',
    (event) => {
      // Ignoring selection after a gesture must NOT allow the prototype's link
      // defaults/onclick handlers to run and navigate this iframe to the editor.
      event.preventDefault()
      event.stopImmediatePropagation()
      if (suppressClick || event.target.closest?.('#qp-manual-highlight')) return
      const el = event.target.closest?.('[' + marker + ']')
      if (el) {
        const key = el.getAttribute(marker)
        if (el !== selected) selectedTextIndex = -1
        select(key)
      }
    },
    true,
  )
  doc.addEventListener(
    'dblclick',
    (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      const summary = textSelection(selected, -1)
      if (!summary.segments.length) return
      setInspectorTab('attributesTab')
      if (summary.segments.length > 1 && selectedTextIndex < 0) $('textSegment').focus()
      else {
        $('text').focus()
        $('text').select()
      }
    },
    true,
  )
  doc.addEventListener(
    'submit',
    (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    true,
  )
  doc.addEventListener(
    'scroll',
    () => {
      if (!selected || gesture) return
      // Scrolling only changes geometry, never the inspector's pending input.
      positionHighlight(liveNodes.get(selected))
      updateSiblingButtons()
    },
    true,
  )
  if (selectedKey) select(selectedKey)
  update()
})
$('dragMode').onchange = () => {
  if (gesture) return
  syncGridStep(frame.contentDocument.querySelector('[' + marker + '="' + selectedKey + '"]'))
  directInteraction?.draggable({ enabled: positionDragMode(), ...dragOptions() })
  interaction?.draggable(dragOptions(true))
  frame.contentDocument.documentElement.toggleAttribute('data-qp-free-drag', positionDragMode())
  const handle = frame.contentDocument.querySelector('#qp-manual-highlight [data-move]')
  if (handle) handle.textContent = dragHandleLabel()
  status({
    free: '自由拖动：直接拖动元素，位移将写入原型 HTML 样式',
    parent: '父容器内拖拽：支持惯性移动，结束时将元素完整限制在父容器内；位移写入原型 HTML 样式',
    grid: `容器网格拖拽：按 ${gridStep()}px 网格吸附，并限制在父容器内`,
  }[$('dragMode').value])
  update()
}
$('gridSize').onchange = () => {
  if (gesture || busy || !ready) return
  $('gridSize').value = String(gridStep())
  $('gridAuto').checked = false
  if ($('dragMode').value === 'grid') status(`容器网格拖拽：已设置为 ${gridStep()}px 网格`)
}
$('gridSize').onkeydown = (event) => {
  if (event.key === 'Enter') event.target.blur()
}
$('gridAuto').onchange = () => {
  if (gesture || busy || !ready) return
  syncGridStep(frame.contentDocument.querySelector('[' + marker + '="' + selectedKey + '"]'))
  status(`容器网格拖拽：${$('gridAuto').checked ? '自动' : '手动'}步长 ${gridStep()}px`)
}
$('applyText').onclick = () => {
  const selectedText = textSelection(selected, selectedTextIndex)
  if (!selectedText.editable) return
  const all = attributeTargets()
  const targets = all.filter((element) => textSelection(element, selectedTextIndex).editable)
  // Capture text nodes first: matching ancestors and descendants may share one.
  const texts = new Map(targets.map((element) => [element, textSelection(element, selectedTextIndex)]))
  const value = $('text').value
  commitAttributes((element) => texts.get(element).apply(value), targets, all.length - targets.length)
}
$('textSegment').onchange = () => {
  selectedTextIndex = Number($('textSegment').value)
  if (!Number.isInteger(selectedTextIndex)) selectedTextIndex = -1
  select(selectedKey)
  $('text').focus()
  $('text').select()
}
document.querySelectorAll('input[name="attributeScope"]').forEach((input) => {
  input.onchange = () => {
    imageRequest++
    updateAttributeScope()
  }
})
async function applyImage(read) {
  if (!selected || !imageTarget(selected) || !ready || busy || gesture || imagePending) return
  const target = selected,
    targets = attributeTargets(),
    request = ++imageRequest
  imagePending = true
  $('applyImage').disabled = $('imageFile').disabled = true
  updateAttributeScope()
  status('正在读取并检查图片…')
  try {
    const src = await read()
    await new Promise((resolve, reject) => {
      const preview = new Image()
      const timeout = setTimeout(() => {
        preview.src = ''
        reject(new Error('图片加载超时，请检查地址或网络'))
      }, 15000)
      preview.onload = () => {
        clearTimeout(timeout)
        resolve()
      }
      preview.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('图片无法加载，请检查格式、地址或防盗链限制'))
      }
      preview.referrerPolicy = 'no-referrer'
      preview.src = src
    })
    if (request !== imageRequest || selected !== target || !ready || busy || gesture ||
        targets.some((element) => !source.body.contains(element)))
      throw new Error('选择或页面已改变，请重新选择图片后替换')
    // Replacing an outer SVG also replaces any matched nested SVGs it contains.
    const imageTargets = targets.filter((element) => !targets.some((other) => other !== element && other.contains(element)))
    const replacements = imageTargets.map((element) => ({
      element, size: liveNodes.get(element)?.getBoundingClientRect(),
    }))
    const clone = source.documentElement.cloneNode(true)
    const originals = Array.from(source.documentElement.querySelectorAll('*'))
    const copies = Array.from(clone.querySelectorAll('*'))
    const copyByNode = new Map(originals.map((element, index) => [element, copies[index]]))
    for (const { element, size } of replacements) replaceImage(copyByNode.get(element), src, size)
    // Keep the final request below the workspace API body limit, including JSON escaping.
    if (
      new TextEncoder().encode(JSON.stringify({ html: clone.outerHTML, revision })).length >
      4 * 1024 * 1024
    )
      throw new Error('页面与图片总体积过大，请使用更小的图片或网络地址')
    let replacement
    if (commit(() => {
      for (const { element, size } of replacements) {
        const containsSelection = element === target || element.contains(target)
        const image = replaceImage(element, src, size)
        if (containsSelection) replacement = image
      }
    }, () => replacement) && $('scopeSimilar').checked)
      status(`已替换 ${targets.length} 个类似图片元素，尚未写入工作区`)
  } catch (error) {
    status(error.message, true)
  } finally {
    imagePending = false
    $('applyImage').disabled = $('imageFile').disabled = false
    updateAttributeScope()
  }
}
$('applyImage').onclick = () => applyImage(() => imageUrl($('imageUrl').value))
$('imageFile').onchange = () => {
  const file = $('imageFile').files[0]
  if (!file) return
  void applyImage(() => {
    validateImageFile(file)
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('文件读取失败，请重新选择'))
      reader.readAsDataURL(file)
    })
  })
}
document.querySelectorAll('[data-style]').forEach((input) => {
  input.onkeydown = (event) => {
    if (event.key === 'Enter') input.blur()
  }
  input.onchange = () => {
    if (!selected || !ready || busy) return
    const property = input.dataset.style,
      value = input.value.trim()
    if (value && !CSS.supports(property, value)) {
      status('无效的 CSS 值，请带上 px、% 等单位', true)
      return
    }
    const targets = attributeTargets()
    const dimension = property === 'width' || property === 'height'
    const inline = new Set(dimension && value ? targets.filter((element) => {
      const live = liveNodes.get(element)
      return live && frame.contentWindow.getComputedStyle(live).display === 'inline'
    }) : [])
    commitAttributes((element) => {
      if (dimension) applyElementDimension(element, property, value, inline.has(element))
      else if (value) element.style.setProperty(property, value, 'important')
      else element.style.removeProperty(property)
    }, targets)
  }
})
$('parent').onclick = () => {
  const parent = selected?.parentElement
  for (const [key, el] of nodes)
    if (el === parent) {
      select(key)
      break
    }
}
document.querySelectorAll('[data-sibling]').forEach((button) => {
  button.onclick = () => {
    if (!ready || busy || gesture) return
    const key = siblingKey(button.dataset.sibling)
    if (key) {
      liveNodes.get(nodes.get(key))?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      select(key)
    }
  }
})
$('swapSteps').onchange = () => {
  $('swapSteps').value = String(swapCount())
  updateSiblingButtons()
}
$('swapSteps').onkeydown = (event) => {
  if (event.key === 'Enter') event.target.blur()
}
document.querySelectorAll('[data-swap]').forEach((button) => {
  button.onclick = () => {
    if (!ready || busy || gesture || !selected) return
    const direction = button.dataset.swap, count = swapCount()
    const target = nodes.get(siblingKey(direction, count))
    if (!target || target.parentElement !== selected.parentElement) {
      updateSiblingButtons()
      status('该方向没有第 ' + count + ' 个可调换的兄弟元素', true)
      return
    }
    try {
      const node = selected
      const first = elementPositionState(liveNodes.get(node))
      const second = elementPositionState(liveNodes.get(target))
      const [firstValue, secondValue] = siblingSwapTranslations(first, second)
      commit(() => {
        applyFreeDrag(node, firstValue, first.inline)
        applyFreeDrag(target, secondValue, second.inline)
      }, () => node)
      liveNodes.get(node)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      select(keyFor(node))
      status('已与' + { left: '左侧', right: '右侧', up: '上侧', down: '下侧' }[direction] + '第 ' + count + ' 个兄弟调换位置，尚未写入工作区')
    } catch (error) { status(error.message, true) }
  }
})
$('zIndex').onkeydown = (event) => {
  if (event.key === 'Enter') event.target.blur()
}
$('zIndex').onchange = () => {
  const value = Number($('zIndex').value)
  if (!Number.isInteger(value)) {
    $('zIndex').value = String(elementLayer())
    status('元素层级必须是整数', true)
    return
  }
  setElementLayer(value)
}
document.querySelectorAll('[data-layer]').forEach((button) => {
  button.onclick = () => {
    if (!selected || !ready || busy || gesture) return
    const current = elementLayer(), layers = siblingLayers()
    const value = {
      top: Math.max(...layers) + 1,
      bottom: Math.min(...layers) - 1,
      raise: current + 1,
      lower: current - 1,
    }[button.dataset.layer]
    if (!Number.isInteger(value)) return
    setElementLayer(value)
    status({
      top: '已将元素置于同级元素顶层',
      bottom: '已将元素置于同级元素底层',
      raise: '已将元素提升一层',
      lower: '已将元素下移一层',
    }[button.dataset.layer] + '，尚未写入工作区')
  }
})
function runChildLayout(action) {
    if (!ready || busy || gesture || !selected) return false
    const rows = childLayoutRows()
    const row = selectedChildLayoutRow(rows)
    const children = row?.items.map(({ node }) => node) || []
    if (!children.length || action === 'horizontal' && children.length < 2) {
      updateChildLayoutControls()
      status(rows.length > 1 && !children.length
        ? '检测到多行子元素，请先选择需要调整的行'
        : action === 'horizontal' ? '水平等距至少需要 2 个直接子元素' : '当前元素没有可排列的直接子元素', true)
      return false
    }
    const edgeMode = document.querySelector('[name="childEdgeMode"]:checked')?.value || 'edge'
    try {
      const changed = rows.length > 1
        ? applyChildLayoutRow(row, action, edgeMode)
        : commit(() => applyChildLayout(row.container, action, edgeMode, children), selectedKey)
      if (!changed) {
        status('当前排列方式已经生效')
        return false
      }
      const label = {
        horizontal: edgeMode === 'edge' ? '水平等距排列（首尾贴边）' : '水平等距排列（两侧留白）',
        center: '上下居中排列',
        left: '左对齐排列',
        right: '右对齐排列',
      }[action]
      const spacing = action === 'horizontal' && edgeMode === 'inset'
        ? '，左右留白与每个元素之间的空白保持相等'
        : '，边距和间距由容器自动计算'
      const rowLabel = rows.length > 1 ? `第 ${Number($('childLayoutRow').value) + 1} 行` : '子元素'
      status(`已对${rowLabel}应用${label}${spacing}，其他行保持不变，尚未写入AI工作区`)
      return true
    } catch (error) {
      status(error.message, true)
      return false
    }
}
document.querySelectorAll('[data-child-layout]').forEach((button) => {
  button.onclick = () => {
    runChildLayout(button.dataset.childLayout)
  }
})
document.querySelectorAll('[name="childEdgeMode"]').forEach((input) => {
  input.onclick = () => {
    if (!ready || busy || gesture || input.disabled) return
    if ($('layoutHorizontal').disabled) {
      const rows = childLayoutRows()
      status(rows.length > 1 && !selectedChildLayoutRow(rows)
        ? '已切换边缘方式；请先选择需要水平排列的行'
        : '已切换边缘方式；当前行至少需要 2 个元素才能水平排列')
      return
    }
    runChildLayout('horizontal')
  }
})
$('childLayoutRow').onchange = () => {
  updateChildLayoutControls()
  if ($('childLayoutRow').value !== '')
    status(`已选择第 ${Number($('childLayoutRow').value) + 1} 行，请选择排列方式`)
}
$('child').onclick = () => {
  const options = $('children').options
  if (options.length === 2) {
    select(options[1].value)
  } else if (options.length > 2) {
    $('childPicker').hidden = !$('childPicker').hidden
    if (!$('childPicker').hidden) $('children').focus()
  }
}
$('children').onchange = () => {
  const key = $('children').value
  if (key) select(key)
}
$('duplicate').onclick = () => {
  if (!selected) return
  let copied
  commit(
    () => {
      const clone = selected.cloneNode(true)
      // Do not introduce duplicate document IDs.
      clone.removeAttribute('id')
      clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'))
      selected.after(clone)
      copied = clone
    },
    () => copied,
  )
}
$('delete').onclick = () => {
  if (selected) commit(() => selected.remove(), null)
}
function restore(delta) {
  if (busy || !ready || gesture || position + delta < 0 || position + delta >= history.length) return
  const entry = history[delta < 0 ? position : position + 1]
  const direction = delta < 0 ? 'before' : 'after'
  applyDomChanges(entry.changes, direction)
  applyDomChanges(entry.changes, direction, liveFor)
  position += delta
  refreshSelection(delta < 0 ? entry.beforeKey : entry.afterKey)
  update()
  status('已' + (delta < 0 ? '撤销' : '重做'))
}
$('undo').onclick = () => restore(-1)
$('redo').onclick = () => restore(1)
async function request(method = 'GET', data, submissionId) {
  const response = await fetch(base + '__layrr__/manual-data' + (submissionId ? '?submission=' + encodeURIComponent(submissionId) : ''), {
    method,
    headers: { 'x-quickpage-manual': '1', 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
  })
  const result = await response.json()
  if (!response.ok) {
    const error = new Error(result.error || '工作区请求失败')
    error.status = response.status
    throw error
  }
  return result
}
async function load() {
  if (busy) return
  if (source && serialize() !== saved && !confirm('重新载入会丢弃未写入的修改，继续吗？')) return
  busy = true
  try {
    const data = await request()
    revision = data.revision
    retrySubmission = null
    source = new DOMParser().parseFromString(data.html, 'text/html')
    nodes = new Map()
    nodeKeys = new WeakMap()
    nextKey = 0
    saved = serialize()
    history = [{ html: saved }]
    position = 0
    render(null)
    status('点选元素开始编辑；所有操作均不调用 AI')
    if (data.pendingSubmissionId) {
      pendingSubmission = data.pendingSubmissionId
      saved = ''
      void waitForVersion(data.pendingSubmissionId, serialize())
    }
  } catch (error) {
    status(error.message, true)
  } finally {
    busy = !!pendingSubmission
    if (source) update()
  }
}
$('reload').onclick = load
async function waitForVersion(id, submittedHtml, payload) {
  pendingSubmission = id
  busy = true
  update()
  const started = Date.now()
  let needsSubmit = !!payload
  while (pendingSubmission === id) {
    try {
      if (needsSubmit) {
        const result = await request('POST', payload)
        revision = result.revision
        needsSubmit = false
        if (result.submissionId !== id) throw Object.assign(new Error('工作区尚未支持版本提交，请保留修改并重新打开工作区'), { status: 409 })
      }
      const data = await request('GET', undefined, id)
      if (data.submissionStatus?.id === id) {
        const result = data.submissionStatus
        // Keep the submitted revision so another window's newer edits still conflict.
        revision = result.revision
        pendingSubmission = null
        retrySubmission = null
        busy = false
        if (result.success) {
          saved = submittedHtml
          $('versionFeedback').value = ''
        }
        status(result.message, !result.success)
        update()
        return
      }
      if (data.pendingSubmissionId !== id)
        throw Object.assign(new Error('版本提交已失效，请保留修改并重新提交'), { status: 409 })
      status(Date.now() - started > 10000
        ? '已写入AI工作区，正在等待保存版本。请保持小豆原型原工作区打开。'
        : '已写入AI工作区，正在自动保存到页面历史…')
    } catch (error) {
      if (error.status >= 400 && error.status < 500) {
        pendingSubmission = null
        busy = false
        status(error.message, true)
        update()
        return
      }
      status('正在重试获取保存结果：' + error.message, true)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
$('save').onclick = () => {
  if (busy || !ready || gesture || serialize() === saved) return
  $('versionFeedbackError').hidden = true
  $('versionDialog').showModal()
  $('versionFeedback').focus()
}
$('cancelVersion').onclick = () => $('versionDialog').close()
$('versionForm').onsubmit = async (event) => {
  event.preventDefault()
  if (busy || !ready || gesture || serialize() === saved) return
  const feedbackText = $('versionFeedback').value.trim()
  if (!feedbackText || feedbackText.length > 500) {
    $('versionFeedbackError').textContent = '请输入 1–500 字的版本修改备注'
    $('versionFeedbackError').hidden = false
    $('versionFeedback').focus()
    return
  }
  const html = serialize()
  if (!retrySubmission || retrySubmission.html !== html || retrySubmission.feedbackText !== feedbackText)
    retrySubmission = { html, revision, submit: true, feedbackText, submissionId: crypto.randomUUID() }
  $('versionDialog').close()
  busy = true
  update()
  try {
    await waitForVersion(retrySubmission.submissionId, html, retrySubmission)
  } catch (error) {
    status(error.message, true)
  } finally {
    busy = !!pendingSubmission
    update()
  }
}
window.addEventListener('beforeunload', (event) => {
  finishNudge()
  if (source && (pendingSubmission || serialize() !== saved)) {
    event.preventDefault()
    event.returnValue = ''
  }
})
void load()
