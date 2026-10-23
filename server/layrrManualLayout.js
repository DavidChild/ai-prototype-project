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
