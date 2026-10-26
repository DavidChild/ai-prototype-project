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

/** Keep workspace-specific behavior separate from the official selector compatibility fix. */
export function adaptLayrrWorkspaceOverlay(source: string): string {
  let adapted = adaptLayrrOverlay(source)
  const replacements = [
    [
      '    #${L}-toasts{position:fixed;bottom:56px;right:16px;z-index:999999;display:flex;flex-direction:column-reverse;gap:6px}',
      '    #${L}-toasts{position:fixed;top:16px;bottom:auto;right:16px;z-index:1000000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow-y:auto;pointer-events:none}',
    ],
    [
      '      backdrop-filter:blur(10px);display:flex;align-items:center;gap:6px;max-width:240px;',
      '      backdrop-filter:blur(10px);display:flex;align-items:flex-start;gap:6px;max-width:min(420px,calc(100vw - 32px));min-height:0;flex-shrink:0;box-sizing:border-box;pointer-events:auto;',
    ],
    [
      '    .${L}-toast i{font-size:${size.xl};flex-shrink:0}',
      '    .${L}-toast i{font-size:${size.xl};flex-shrink:0}\n    .${L}-toast span{min-width:0;white-space:normal;overflow-wrap:anywhere}',
    ],
    [
      '    el.innerHTML = `<i class="${ic}"></i><span>${msg}</span>`;',
      `    const icon = document.createElement("i");
    icon.className = ic;
    const text = document.createElement("span");
    text.textContent = String(msg);
    el.append(icon, text);`,
    ],
    [
      '    const saved = loadState2();',
      '    const saved = loadState2();\n    if (!saved.mode) saved.mode = "edit";',
    ],
    [
      '    function onEditResult(msg) {',
      `    function onEditResult(msg) {
      if (msg.timestamp) {
        if (msg.timestamp <= (app2.completedTimestamp || 0)) return;
        app2.completedTimestamp = msg.timestamp;
        app2.lastEditTimestamp = Math.max(app2.lastEditTimestamp, msg.timestamp);
        save2();
      }`,
    ],
  ] as const
  for (const [before, after] of replacements) {
    if (adapted.split(before).length !== 2)
      throw new Error('Layrr 工作区适配不兼容，请检查固定依赖版本')
    adapted = adapted.replace(before, after)
  }
  return adapted
}
