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

export function applyElementSize(node, box, inline = false) {
  for (const [name, value] of Object.entries({
    width: box.width + 'px', height: box.height + 'px',
    'box-sizing': 'border-box',
    // Flex/grid and original min/max rules must not silently override the gesture.
    'min-width': '0px', 'min-height': '0px', 'max-width': 'none', 'max-height': 'none',
    'flex-shrink': '0', 'flex-grow': '0', 'flex-basis': 'auto',
  })) node.style.setProperty(name, value, 'important')
  if (inline) node.style.setProperty('display', 'inline-block', 'important')
}
