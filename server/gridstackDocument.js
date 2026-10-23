export function gridPosition(rect, container, cellHeight = 24) {
  const unit = Math.max(1, container.width / 12)
  const x = Math.max(0, Math.min(11, Math.round((rect.left - container.left) / unit)))
  return {
    x,
    y: Math.max(0, Math.round((rect.top - container.top) / cellHeight)),
    w: Math.max(1, Math.min(12 - x, Math.round(rect.width / unit))),
    h: Math.max(2, Math.ceil(rect.height / cellHeight)),
  }
}
export function normalizeLayout(items) {
  return items.map(({ id, x, y, w, h }) => {
    if (typeof id !== 'string' || ![x, y, w, h].every(Number.isFinite))
      throw new Error('网格数据无效')
    x = Math.max(0, Math.min(11, Math.round(x)))
    return {
      id,
      x,
      y: Math.max(0, Math.round(y)),
      w: Math.max(1, Math.min(12 - x, Math.round(w))),
      h: Math.max(2, Math.round(h)),
    }
  })
}
export function applyGridDocument(doc, container, items, layout, cellHeight = 24) {
  const positions = normalizeLayout(layout)
  if (
    positions.length !== items.length ||
    new Set(positions.map((p) => p.id)).size !== items.length ||
    positions.some((p) => !items.some((item) => item.id === p.id))
  )
    throw new Error('模块映射不一致，拒绝覆盖')
  // Preserve the selected container and every original descendant; replace only
  // its layout. Ignored script/style nodes stay in their original relative order.
  for (const item of items) {
    const pos = positions.find((p) => p.id === item.id)
    const wrapper = doc.createElement('div')
    wrapper.setAttribute('data-qp-grid-item', item.id)
    wrapper.setAttribute('data-qp-grid-position', JSON.stringify(pos))
    wrapper.style.cssText =
      'min-width:0;overflow:auto;grid-column:' +
      (pos.x + 1) +
      '/span ' +
      pos.w +
      ';grid-row:' +
      (pos.y + 1) +
      '/span ' +
      pos.h
    item.node.replaceWith(wrapper)
    wrapper.append(item.node)
    for (const [key, value] of Object.entries({
      position: 'relative',
      inset: 'auto',
      width: '100%',
      maxWidth: '100%',
      minWidth: '0',
      height: '100%',
      margin: '0',
      boxSizing: 'border-box',
    }))
      item.node.style[key] = value
  }
  container.setAttribute('data-qp-grid', '1')
  container.style.display = 'grid'
  container.style.gridTemplateColumns = 'repeat(12,minmax(0,1fr))'
  container.style.gridAutoRows = cellHeight + 'px'
  container.style.gap = '0'
  container.style.height = 'auto'
  container.style.alignItems = 'stretch'
}
