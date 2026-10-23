const excluded = new Set([
  'SCRIPT',
  'STYLE',
  'SVG',
  'MATH',
  'TEMPLATE',
  'NOSCRIPT',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'IMG',
  'BR',
  'HR',
])

// Edit the text node, never replace a container's textContent (which removes icons/markup).
export function textSelection(element) {
  const texts = []
  function visit(node) {
    if (node.nodeType === 3) {
      if (node.nodeValue?.trim()) texts.push(node)
      return
    }
    if (
      node.nodeType !== 1 ||
      excluded.has(node.tagName.toUpperCase()) ||
      node.hidden ||
      node.getAttribute('aria-hidden') === 'true' ||
      node.style?.display === 'none' ||
      node.style?.visibility === 'hidden'
    )
      return
    for (const child of node.childNodes) visit(child)
  }
  if (element) visit(element)
  const target = texts.length === 1 ? texts[0] : null
  const emptyLeaf =
    element && !excluded.has(element.tagName.toUpperCase()) && element.childNodes.length === 0
  return {
    value: texts.map((node) => node.nodeValue.trim()).join('\n'),
    editable: Boolean(target || emptyLeaf),
    apply(value) {
      if (target) {
        const original = target.nodeValue
        target.nodeValue = original.match(/^\s*/)[0] + value + original.match(/\s*$/)[0]
      } else if (emptyLeaf) element.textContent = value
      else throw new Error('请通过选择子级定位具体文字')
    },
  }
}
