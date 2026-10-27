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
  const translations = [
    ['        <div class="${L}-pb">Edit</div>', '        <div class="${L}-pb">AI 局部编辑</div>', 1],
    ['placeholder="Describe the change..."', 'placeholder="描述你希望 AI 如何修改选中元素…"', 1],
    ['<span><kbd>Enter</kbd> send</span><span><kbd>Esc</kbd> close</span>', '<span><kbd>Enter</kbd> 发送</span><span><kbd>Shift+Enter</kbd> 换行</span><span><kbd>Esc</kbd> 关闭</span>', 1],
    ['      <div class="${L}-hh">History</div>', '      <div class="${L}-hh">修改历史</div>', 1],
    ['      <div class="${L}-he-empty">No edits yet</div>', '      <div class="${L}-he-empty">暂无修改记录</div>', 1],
    ['data-tip="Browse"', 'data-tip="浏览页面"', 1],
    ['data-tip="Edit"', 'data-tip="AI 局部编辑"', 1],
    ['data-tip="History"', 'data-tip="修改历史"', 1],
    ['<span>History</span><button class="${L}-hh-close">', '<span>修改历史</span><button class="${L}-hh-close">', 2],
    ['<div class="${L}-he-empty">No edits yet</div>', '<div class="${L}-he-empty">暂无修改记录</div>', 1],
    ['<div class="${L}-he-empty">Could not load history</div>', '<div class="${L}-he-empty">修改历史加载失败</div>', 1],
    ['<span>History (${data.commits.length})</span>', '<span>修改历史（${data.commits.length}）</span>', 1],
    ['<span class="${L}-he-tag latest">latest</span>', '<span class="${L}-he-tag latest">最新</span>', 1],
    ['title="Revert to this version"', 'title="恢复到此版本"', 1],
    ['Revert to this version?<br>All edits after this point will be lost.', '确认恢复到此版本？<br>此版本之后的所有修改都将丢失。', 1],
    ['<button class="${L}-confirm-cancel">Cancel</button>', '<button class="${L}-confirm-cancel">取消</button>', 1],
    ['<button class="${L}-confirm-yes">Revert</button>', '<button class="${L}-confirm-yes">确认恢复</button>', 1],
    ['Click to select an element or <kbd>Shift+click</kbd> to select multiple', '点击选择一个元素，或按住 <kbd>Shift</kbd> 点击选择多个元素', 1],
    [' || "(empty)"', ' || "（空内容）"', 1],
    ['<div class="${L4}-et">Selected<span', '<div class="${L4}-et">已选择<span', 1],
    ['toast2("Edit timed out \\u2014 no response received", "error");', 'toast2("编辑超时，未收到处理结果", "error");', 1],
    ['toast2("Done!", "success");', 'toast2("修改完成", "success");', 1],
    ['toast2(msg.message || "Edit failed", "error");', 'toast2(msg.message || "修改失败", "error");', 1],
    ['toast2(`Previewing: ${msg.message || msg.hash.slice(0, 7)}`, "info");', 'toast2(`正在预览：${msg.message || msg.hash.slice(0, 7)}`, "info");', 1],
    ['toast2("Preview failed", "error");', 'toast2("版本预览失败", "error");', 1],
    ['toast2("Back to latest", "success");', 'toast2("已返回最新版本", "success");', 1],
    ['toast2("Restore failed", "error");', 'toast2("返回最新版本失败", "error");', 1],
    ['toast2("Permanently reverted", "success");', 'toast2("已恢复到所选版本", "success");', 1],
    ['toast2("Revert failed", "error");', 'toast2("版本恢复失败", "error");', 1],
    ['toast2("Go back to latest to make edits", "info");', 'toast2("请先返回最新版本后再进行编辑", "info");', 1],
    ['toast2("Editing...", "info");', 'toast2("AI 正在修改…", "info");', 1],
  ] as const
  for (const [before, after, expected] of translations) {
    const count = adapted.split(before).length - 1
    if (count !== expected)
      throw new Error(`Layrr 中文适配不兼容：${before}（期望 ${expected} 处，实际 ${count} 处）`)
    adapted = adapted.split(before).join(after)
  }
  return adapted
}
