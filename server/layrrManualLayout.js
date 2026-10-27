export function moveModule(source, target, placement) {
  if (!source || !target || source === target || source.contains(target))
    throw new Error('不能移动到自身或自己的下级中')
  if (!['before', 'after', 'inside'].includes(placement)) throw new Error('无效放置位置')
  if (placement === 'inside') {
    if (
      ![
        'DIV',
        'SECTION',
        'MAIN',
        'ARTICLE',
        'ASIDE',
        'HEADER',
        'FOOTER',
        'NAV',
        'LI',
        'TD',
        'TH',
        'FORM',
        'FIELDSET',
        'FIGURE',
        'DETAILS',
      ].includes(target.tagName.toUpperCase())
    )
      throw new Error('请选择可容纳模块的容器，或放在元素前后')
    target.append(source)
  } else if (placement === 'before') target.before(source)
  else target.after(source)
}

export function keyboardCommand(event) {
  if (
    event.isComposing ||
    event.altKey ||
    event.target?.closest?.(
      'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
    )
  )
    return null
  const modifier = event.ctrlKey || event.metaKey
  if (modifier && event.key.toLowerCase() === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (modifier && event.key.toLowerCase() === 'y') return 'redo'
  if (!modifier && event.key === 'Delete') return 'delete'
  return null
}

export function normalizeGridStep(value) {
  const number = Number(value)
  return String(value).trim() && Number.isFinite(number)
    ? Math.min(500, Math.max(1, Math.round(number)))
    : 30
}

export function automaticGridStep(style) {
  const pixels = (value) => /^\d+(?:\.\d+)?px$/.test(value || '') ? parseFloat(value) : 0
  const gaps = [style?.rowGap, style?.columnGap].map(pixels).filter((value) => value > 0)
  return gaps.length ? normalizeGridStep(Math.min(...gaps)) : 30
}

export function directionalSibling(rect, candidates, direction) {
  if (!['left', 'right', 'up', 'down'].includes(direction)) return null
  const horizontal = direction === 'left' || direction === 'right'
  const sign = direction === 'left' || direction === 'up' ? -1 : 1
  const center = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }
  let closest = null, best = null
  for (const candidate of candidates) {
    const next = candidate.rect
    if (!(next.right > next.left && next.bottom > next.top)) continue
    const dx = (next.left + next.right) / 2 - center.x
    const dy = (next.top + next.bottom) / 2 - center.y
    if ((horizontal ? dx : dy) * sign <= 0.5) continue
    const crossGap = horizontal
      ? Math.max(rect.top - next.bottom, next.top - rect.bottom, 0)
      : Math.max(rect.left - next.right, next.left - rect.right, 0)
    const edgeGap = horizontal
      ? Math.max(rect.left - next.right, next.left - rect.right, 0)
      : Math.max(rect.top - next.bottom, next.top - rect.bottom, 0)
    // Prefer the same visual row/column, then the nearest edge and center.
    const score = [crossGap > 0 ? 1 : 0, Math.hypot(edgeGap, crossGap), Math.hypot(dx, dy)]
    const better = !best || score.some((value, index) =>
      value < best[index] && score.slice(0, index).every((previous, i) => previous === best[i]))
    if (better) { closest = candidate.key; best = score }
  }
  return closest
}

export function nthDirectionalSibling(rect, candidates, direction, count = 1) {
  if (!Number.isInteger(count) || count < 1 || count > candidates.length) return null
  let current = rect, remaining = candidates.slice(), key = null
  for (let step = 0; step < count; step++) {
    key = directionalSibling(current, remaining, direction)
    const next = remaining.find((candidate) => candidate.key === key)
    if (!next) return null
    current = next.rect
    remaining = remaining.filter((candidate) => candidate !== next)
  }
  return key
}

export function siblingSwapTranslations(first, second) {
  const dx = second.rect.left - first.rect.left
  const dy = second.rect.top - first.rect.top
  const translate = (state, sign) => {
    const { a, b, c, d } = state.inverse
    return dragTranslation(state.translate, sign * (a * dx + c * dy), sign * (b * dx + d * dy))
  }
  // Compute both before editing either element so an invalid geometry is atomic.
  return [translate(first, 1), translate(second, -1)]
}

export function childLayoutStyles(action, edgeMode = 'edge', childCount = 0) {
  if (!['horizontal', 'center', 'left', 'right'].includes(action))
    throw new Error('无效的子元素排列方式')
  if (!['edge', 'inset'].includes(edgeMode)) throw new Error('无效的水平排列边缘方式')
  if (action === 'horizontal' && edgeMode === 'inset') {
    if (!Number.isInteger(childCount) || childCount < 2) throw new Error('两侧留白至少需要 2 个直接子元素')
    return {
      display: 'flex',
      'flex-direction': 'row',
      'flex-wrap': 'nowrap',
      'justify-content': 'space-evenly',
    }
  }
  const styles = {
    display: 'flex',
    'flex-direction': 'row',
    'flex-wrap': 'nowrap',
  }
  if (action === 'horizontal') styles['justify-content'] = 'space-between'
  else if (action === 'center') styles['align-items'] = 'center'
  else styles['justify-content'] = action === 'left' ? 'flex-start' : 'flex-end'
  return styles
}

export function applyChildLayout(container, action, edgeMode = 'edge', children = Array.from(container?.children || [])) {
  if (!container?.style) throw new Error('请选择包含直接子元素的容器')
  const styles = childLayoutStyles(action, edgeMode, children.length)
  const inset = action === 'horizontal' && edgeMode === 'inset'
  if (action !== 'center') {
    for (const property of ['grid-template-columns', 'grid-auto-flow', 'column-gap', 'justify-items'])
      container.style.removeProperty(property)
    for (const child of children) {
      child.style?.removeProperty?.('grid-column')
      child.style?.removeProperty?.('justify-self')
    }
  }
  // Vertical centering should not cancel an existing six-slot inset layout.
  if (action === 'center' && container.style.getPropertyValue('display') === 'grid') {
    delete styles.display
    delete styles['flex-direction']
    delete styles['flex-wrap']
  }
  for (const [property, value] of Object.entries(styles))
    container.style.setProperty(property, value, 'important')
  if (inset) children.forEach((child) => {
    child.style?.removeProperty?.('grid-column')
    child.style?.removeProperty?.('justify-self')
  })
}

export function groupChildLayoutRows(items) {
  const sorted = items.filter(({ rect }) => rect && [rect.top, rect.left, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0)
    .slice().sort((first, second) => first.rect.top - second.rect.top || first.rect.left - second.rect.left)
  const rows = []
  for (const item of sorted) {
    const center = item.rect.top + item.rect.height / 2
    let match = null, distance = Infinity
    for (const row of rows) {
      const current = Math.abs(center - row.center)
      const tolerance = Math.max(8, Math.min(item.rect.height, row.height) * 0.45)
      if (current <= tolerance && current < distance) {
        match = row
        distance = current
      }
    }
    if (!match) {
      match = { items: [], center, height: item.rect.height }
      rows.push(match)
    }
    match.items.push(item)
    match.center = match.items.reduce((sum, entry) => sum + entry.rect.top + entry.rect.height / 2, 0) / match.items.length
    match.height = match.items.reduce((sum, entry) => sum + entry.rect.height, 0) / match.items.length
  }
  return rows.sort((first, second) => first.center - second.center)
    .map((row) => row.items.sort((first, second) => first.rect.left - second.rect.left))
}

export function childRowLayoutOffsets(items, action, edgeMode, bounds) {
  if (!['horizontal', 'center', 'left', 'right'].includes(action)) throw new Error('无效的子元素排列方式')
  if (!['edge', 'inset'].includes(edgeMode)) throw new Error('无效的水平排列边缘方式')
  if (!items.length) throw new Error('请选择需要排列的行')
  if (action === 'horizontal' && items.length < 2) throw new Error('水平等距至少需要 2 个子元素')
  if (!bounds || ![bounds.left, bounds.right].every(Number.isFinite) || bounds.right <= bounds.left)
    throw new Error('无法读取容器可用宽度')
  const ordered = items.slice().sort((first, second) => first.rect.left - second.rect.left)
  if (action === 'center') {
    const center = (Math.min(...ordered.map(({ rect }) => rect.top)) + Math.max(...ordered.map(({ rect }) => rect.bottom))) / 2
    return ordered.map((item) => ({ item, dx: 0, dy: center - (item.rect.top + item.rect.height / 2) }))
  }
  if (action === 'left' || action === 'right') {
    const edge = action === 'left'
      ? Math.min(...ordered.map(({ rect }) => rect.left))
      : Math.max(...ordered.map(({ rect }) => rect.right))
    const delta = (action === 'left' ? bounds.left : bounds.right) - edge
    return ordered.map((item) => ({ item, dx: delta, dy: 0 }))
  }
  if (edgeMode === 'inset') {
    const totalWidth = ordered.reduce((sum, { rect }) => sum + rect.width, 0)
    const gap = (bounds.right - bounds.left - totalWidth) / (ordered.length + 1)
    let left = bounds.left + gap
    return ordered.map((item) => {
      const result = { item, dx: left - item.rect.left, dy: 0 }
      left += item.rect.width + gap
      return result
    })
  }
  const totalWidth = ordered.reduce((sum, { rect }) => sum + rect.width, 0)
  const gap = (bounds.right - bounds.left - totalWidth) / (ordered.length - 1)
  let left = bounds.left
  return ordered.map((item) => {
    const result = { item, dx: left - item.rect.left, dy: 0 }
    left += item.rect.width + gap
    return result
  })
}

// Keep the original transform/rotate/scale and percentage-based translation.
// Individual CSS translate composes with them instead of replacing transform.
export function dragTranslation(translate, dx, dy) {
  if (![dx, dy].every(Number.isFinite)) throw new Error('无效拖动距离')
  const parts = []
  let depth = 0, token = ''
  for (const char of String(translate || 'none').trim()) {
    if (char === '(') depth++
    if (char === ')') depth--
    if (/\s/.test(char) && depth === 0) {
      if (token) parts.push(token)
      token = ''
    } else token += char
  }
  if (token) parts.push(token)
  if (parts[0] === 'none') parts.length = 0
  function offset(value, delta) {
    const rounded = Math.round(delta * 1000) / 1000
    if (!rounded) return value || '0px'
    if (!value || value === '0px' || value === '0') return rounded + 'px'
    return `calc(${value} ${rounded < 0 ? '-' : '+'} ${Math.abs(rounded)}px)`
  }
  return [offset(parts[0], dx), offset(parts[1], dy), ...parts.slice(2)].join(' ')
}

export function applyFreeDrag(node, translate, inline = false) {
  node.style.setProperty('translate', translate, 'important')
  if (inline) node.style.setProperty('display', 'inline-block', 'important')
}

export function resizeBox(initial, delta, edges, minimum = 8) {
  const width = edges.left || edges.right ? Math.max(minimum, initial.width + delta.width) : initial.width
  const height = edges.top || edges.bottom ? Math.max(minimum, initial.height + delta.height) : initial.height
  return {
    width, height,
    dx: edges.left ? initial.width - width : 0,
    dy: edges.top ? initial.height - height : 0,
  }
}

export function applyElementDimension(node, dimension, value, inline = false) {
  if (!['width', 'height'].includes(dimension)) throw new Error('无效尺寸属性')
  if (!value) {
    node.style.removeProperty(dimension)
    return
  }
  for (const [name, styleValue] of Object.entries({
    [dimension]: value,
    'box-sizing': 'border-box',
    // Match drag resizing: existing min/max and flex rules must not mask edits.
    ['min-' + dimension]: '0px', ['max-' + dimension]: 'none',
    'flex-shrink': '0', 'flex-grow': '0', 'flex-basis': 'auto',
  })) node.style.setProperty(name, styleValue, 'important')
  if (inline) node.style.setProperty('display', 'inline-block', 'important')
}

export function applyElementSize(node, box, inline = false) {
  applyElementDimension(node, 'width', box.width + 'px', inline)
  applyElementDimension(node, 'height', box.height + 'px', inline)
}
