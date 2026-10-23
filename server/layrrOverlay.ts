/** Adapt the pinned official overlay without changing node_modules or prototype HTML. */
export function adaptLayrrOverlay(source: string): string {
  // The display-label helper contains the same class join. Only patch getSelector.
  const start = source.indexOf('  function getSelector(el) {')
  const end = source.indexOf('  function posHL(', start)
  if (start < 0 || end < start)
    throw new Error('Layrr 元素定位适配不兼容，请检查固定依赖版本')
  let selectorSource = source.slice(start, end)
  const replacements = [
    [
      'if (el.id) return `#${el.id}`;',
      'if (el.id) return `#${CSS.escape(el.id)}`;',
    ],
    [
      'parts.unshift(`#${cur.id}`);',
      'parts.unshift(`#${CSS.escape(cur.id)}`);',
    ],
    [
      '.slice(0, 2).join(".")',
      '.slice(0, 2).map((className) => CSS.escape(className)).join(".")',
    ],
  ] as const
  for (const [before, after] of replacements) {
    if (selectorSource.split(before).length !== 2)
      throw new Error('Layrr 元素定位适配不兼容，请检查固定依赖版本')
    selectorSource = selectorSource.replace(before, after)
  }
  return source.slice(0, start) + selectorSource + source.slice(end)
}
