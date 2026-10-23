// Served only inside the isolated local workspace, never stored in prototype HTML.
import { textSelection } from './manual-text.js'
import { imageTarget, imageUrl, validateImageFile, replaceImage } from './manual-image.js'
import { moveModule, keyboardCommand, dragTranslation, applyFreeDrag, resizeBox, applyElementSize } from './manual-layout.js'
import { recordDomChanges, applyDomChanges } from './manual-history.js'
const base = location.pathname.slice(0, location.pathname.lastIndexOf('manual'))
const $ = (id) => document.getElementById(id)
const frame = $('canvas')
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
function keyFor(node) {
  return node && nodeKeys.get(node)
}
function positionDragMode() {
  return $('dragMode').value !== 'reorder'
}
function dragHandleLabel() {
  return { free: '自由拖动', parent: '父容器内拖拽', reorder: '移动模块' }[$('dragMode').value]
}
function dragOptions(handle = false) {
  const constrained = $('dragMode').value === 'parent'
  return {
    // Do not resume an inertial gesture with a new pointer: one gesture is one
    // source/history commit, after the final restriction correction has settled.
    inertia: constrained ? { allowResume: false } : false,
    modifiers: constrained ? [window.interact.modifiers.restrictRect({
      restriction: handle
        ? () => (gesture?.live || frame.contentDocument.querySelector('[' + marker + '="' + selectedKey + '"]'))?.parentElement
        : 'parent',
      endOnly: true,
    })] : [],
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
  $('undo').disabled = locked || position <= 0
  $('redo').disabled = locked || position >= history.length - 1
  $('save').disabled = locked || !ready || serialize() === saved
  $('dirty').textContent = ready
    ? serialize() === saved
      ? '工作区已同步'
      : '有未写入修改'
    : '正在载入'
}
function render(key) {
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
  if (!ready || busy) return
  const beforeKey = selectedKey
  const changes = recordDomChanges(source.documentElement, action)
  const html = serialize()
  if (html === history[position].html) return
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
  selected = el
  selectedKey = key
  const live = frame.contentDocument.querySelector('[' + marker + '="' + key + '"]')
  if (!live) return
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
  const text = textSelection(el)
  $('text').value = text.value
  $('text').disabled = $('applyText').disabled = !editableText(el)
  $('textHint').textContent = editableText(el)
    ? '仅修改文字，保留图标和内部标签，不会插入 HTML。'
    : text.value
      ? '包含多段文字，已显示供查看；请选择子级中的具体文字后编辑。'
      : '未找到可编辑文字，请选择具体文字元素。'
  document.querySelectorAll('[data-style]').forEach((input) => {
    const property = input.dataset.style
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
  Object.assign(highlight.style, {
    left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
  })
}
function startFreeDrag(key = selectedKey) {
  if (!ready || busy || gesture || !selectable(nodes.get(key))) return false
  select(key)
  const live = frame.contentDocument.querySelector('[' + marker + '="' + selectedKey + '"]')
  if (!live || !selected) return false
  const style = frame.contentWindow.getComputedStyle(live)
  // Pointer movement is in viewport pixels; translate uses the parent's axes.
  let matrix = new frame.contentWindow.DOMMatrix()
  for (let parent = live.parentElement; parent; parent = parent.parentElement) {
    const transform = frame.contentWindow.getComputedStyle(parent).transform
    if (transform && transform !== 'none')
      matrix = new frame.contentWindow.DOMMatrix(transform).multiply(matrix)
  }
  const inverse = matrix.inverse()
  if (![inverse.a, inverse.b, inverse.c, inverse.d].every(Number.isFinite)) {
    status('该元素的父级使用了不可逆变换，无法自由拖动', true)
    return false
  }
  gesture = {
    kind: 'free', node: selected, key: selectedKey, live,
    translate: style.translate, inline: style.display === 'inline',
    inverse, dx: 0, dy: 0, moved: false,
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
  status(`${$('dragMode').value === 'parent' ? '父容器内移动' : '自由移动'}：X ${Math.round(gesture.dx)}px / Y ${Math.round(gesture.dy)}px；拖动结束后更新原型代码`)
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
      if (el) select(el.getAttribute(marker))
    },
    true,
  )
  doc.addEventListener(
    'dblclick',
    (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (editableText(selected)) {
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
      if (selectedKey && !gesture) select(selectedKey)
    },
    true,
  )
  if (selectedKey) select(selectedKey)
  update()
})
$('dragMode').onchange = () => {
  if (gesture) return
  directInteraction?.draggable({ enabled: positionDragMode(), ...dragOptions() })
  interaction?.draggable(dragOptions(true))
  frame.contentDocument.documentElement.toggleAttribute('data-qp-free-drag', positionDragMode())
  const handle = frame.contentDocument.querySelector('#qp-manual-highlight [data-move]')
  if (handle) handle.textContent = dragHandleLabel()
  status({
    free: '自由拖动：直接拖动元素，位移将写入原型 HTML 样式',
    parent: '父容器内拖拽：支持惯性移动，结束时将元素完整限制在父容器内；位移写入原型 HTML 样式',
    reorder: '结构重排：拖动“移动模块”手柄放到模块前后或容器内',
  }[$('dragMode').value])
}
$('applyText').onclick = () => {
  if (editableText(selected))
    commit(() => {
      textSelection(selected).apply($('text').value)
    })
}
let imageRequest = 0
async function applyImage(read) {
  if (!selected || !imageTarget(selected) || !ready || busy) return
  const target = selected,
    key = selectedKey,
    request = ++imageRequest
  $('applyImage').disabled = $('imageFile').disabled = true
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
    if (request !== imageRequest || selected !== target || !ready || busy || !target.isConnected)
      throw new Error('选择或页面已改变，请重新选择图片后替换')
    const clone = source.documentElement.cloneNode(true)
    // Keep the final request below the workspace API body limit, including JSON escaping.
    if (
      new TextEncoder().encode(JSON.stringify({ html: clone.outerHTML, src })).length >
      4 * 1024 * 1024
    )
      throw new Error('页面与图片总体积过大，请使用更小的图片或网络地址')
    const live = frame.contentDocument.querySelector('[' + marker + '="' + key + '"]')
    const size = live?.getBoundingClientRect()
    commit(() => {
      replaceImage(target, src, size)
    }, null)
  } catch (error) {
    status(error.message, true)
  } finally {
    $('applyImage').disabled = $('imageFile').disabled = false
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
    commit(() => {
      if (value) selected.style.setProperty(property, value, 'important')
      else selected.style.removeProperty(property)
    })
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
async function load() {
  if (busy) return
  if (source && serialize() !== saved && !confirm('重新载入会丢弃未写入的修改，继续吗？')) return
  busy = true
  try {
    const data = await request()
    revision = data.revision
    source = new DOMParser().parseFromString(data.html, 'text/html')
    nodes = new Map()
    nodeKeys = new WeakMap()
    nextKey = 0
    saved = serialize()
    history = [{ html: saved }]
    position = 0
    render(null)
    status('点选元素开始编辑；所有操作均不调用 AI')
  } catch (error) {
    status(error.message, true)
  } finally {
    busy = false
    if (source) update()
  }
}
$('reload').onclick = load
$('save').onclick = async () => {
  if (busy || !ready || serialize() === saved) return
  const html = serialize()
  busy = true
  update()
  try {
    const result = await request('POST', { html, revision })
    revision = result.revision
    saved = html
    status('已写入工作区。请返回 QuickPage 点击“确认保存到当前迭代”。')
  } catch (error) {
    status(error.message, true)
  } finally {
    busy = false
    update()
  }
}
window.addEventListener('beforeunload', (event) => {
  if (source && serialize() !== saved) {
    event.preventDefault()
    event.returnValue = ''
  }
})
void load()
