// Keep node identities alive across undo/redo, including deleted and copied nodes.
// Only source DOM differences are applied; runtime-only preview state is untouched.
function snapshot(root) {
  const nodes = new Map()
  function visit(node) {
    nodes.set(node, {
      attributes: Array.from(node.attributes || [], (attr) => ({
        name: attr.name, localName: attr.localName, namespace: attr.namespaceURI, value: attr.value,
      })),
      value: node.nodeValue,
      children: Array.from(node.childNodes),
    })
    for (const child of node.childNodes) visit(child)
  }
  visit(root)
  return nodes
}

export function recordDomChanges(root, action) {
  const before = snapshot(root)
  action()
  const after = snapshot(root)
  const changes = []
  for (const [node, previous] of before) {
    const next = after.get(node)
    // New/removed subtrees are retained by their parent's children change.
    if (!next) continue
    const attributes = new Map(previous.attributes.map((attr) => [attr.name, attr]))
    for (const attr of next.attributes) {
      const old = attributes.get(attr.name)
      attributes.delete(attr.name)
      if (old?.value !== attr.value)
        changes.push({ type: 'attribute', node, attr, before: old?.value ?? null, after: attr.value })
    }
    for (const attr of attributes.values())
      changes.push({ type: 'attribute', node, attr, before: attr.value, after: null })
    if (previous.value !== next.value)
      changes.push({ type: 'text', node, before: previous.value, after: next.value })
    if (previous.children.length !== next.children.length ||
        previous.children.some((child, index) => child !== next.children[index]))
      changes.push({ type: 'children', node, before: previous.children, after: next.children })
  }
  return changes
}

export function applyDomChanges(changes, direction, resolve = (node) => node) {
  const other = direction === 'before' ? 'after' : 'before'
  for (const change of changes) {
    const node = resolve(change.node)
    const value = change[direction]
    if (change.type === 'attribute') {
      const { attr } = change
      if (value === null) node.removeAttributeNS(attr.namespace, attr.localName)
      else node.setAttributeNS(attr.namespace, attr.name, value)
    } else if (change.type === 'text') node.nodeValue = value
  }
  // Remove first across all parents, then place nodes. This also handles moves
  // between containers without replacing their other children or event handlers.
  const lists = changes.filter((change) => change.type === 'children')
  for (const change of lists) {
    const parent = resolve(change.node)
    const wanted = new Set(change[direction])
    for (const child of change[other]) {
      const live = resolve(child)
      if (!wanted.has(child) && live.parentNode === parent) parent.removeChild(live)
    }
  }
  for (const change of lists) {
    const parent = resolve(change.node)
    let anchor = null
    const wanted = new Set(change[direction].map(resolve))
    for (const child of [...change[direction]].reverse()) {
      const live = resolve(child)
      let next = live.nextSibling
      while (next && !wanted.has(next)) next = next.nextSibling
      if (live.parentNode !== parent || next !== anchor) parent.insertBefore(live, anchor)
      anchor = live
    }
  }
}
