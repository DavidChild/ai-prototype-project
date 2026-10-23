// Keep scripts and inline handlers inert in visual editors, then restore on export.
export function prepareDocument(doc) {
  const scripts = new Map()
  doc.body.querySelectorAll('script').forEach((script, index) => {
    const key = 'qp-script-' + index
    scripts.set(key, script.cloneNode(true))
    const slot = doc.createElement('div')
    slot.setAttribute('data-qp-script', key)
    slot.setAttribute('hidden', '')
    script.replaceWith(slot)
  })
  doc.body.querySelectorAll('*').forEach((el) => {
    const handlers = {}
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) {
        handlers[attr.name] = attr.value
        el.removeAttribute(attr.name)
      }
    }
    if (Object.keys(handlers).length) el.setAttribute('data-qp-handlers', JSON.stringify(handlers))
  })
  return scripts
}
export function restoreDocument(doc, scripts) {
  doc.body.querySelectorAll('[data-qp-script]').forEach((slot) => {
    const script = scripts.get(slot.getAttribute('data-qp-script'))
    if (script) slot.replaceWith(doc.importNode(script, true))
    else slot.remove()
  })
  doc.body.querySelectorAll('[data-qp-handlers]').forEach((el) => {
    for (const [name, value] of Object.entries(JSON.parse(el.getAttribute('data-qp-handlers')))) {
      if (/^on[a-z]+$/i.test(name) && typeof value === 'string') el.setAttribute(name, value)
    }
    el.removeAttribute('data-qp-handlers')
  })
}
