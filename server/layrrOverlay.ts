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
  const attachmentCssNeedle =
    '    .${L}-hn{padding:0 10px 6px;font-size:${size.xs};color:${C.textDim};display:flex;gap:10px}'
  const attachmentCss = [
    attachmentCssNeedle,
    '    .${L}-ar{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;margin-top:10px;min-height:34px}',
    '    .${L}-ab{height:34px;flex:0 0 auto;padding:0 12px;border:1px solid rgba(161,161,170,.38);border-radius:${radius.md};background:rgba(161,161,170,.12);color:${C.text};cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;font-size:${size.sm};font-weight:600;white-space:nowrap}',
    '    .${L}-ab:hover{border-color:rgba(161,161,170,.65);background:rgba(161,161,170,.18)}',
    '    .${L}-ah{min-width:0;color:${C.textMuted};font-size:${size.sm};line-height:1.5}',
    '    .${L}-al{grid-column:1/-1;min-width:0;display:flex;align-items:center;gap:6px}',
    '    .${L}-ac{min-width:0;max-width:220px;height:28px;display:flex;align-items:center;gap:6px;padding:3px 6px 3px 3px;border:1px solid ${C.border};border-radius:${radius.md};background:${C.surface};color:${C.textMuted};font-size:${size.xs}}',
    '    .${L}-ac img{width:20px;height:20px;object-fit:cover;border-radius:3px;flex:0 0 auto}',
    '    .${L}-ac span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '    .${L}-ad{border:0;background:transparent;color:${C.textDim};cursor:pointer;padding:0;font-size:${size.base};line-height:1}',
    '    .${L}-co{margin:0 10px 10px;border:1px solid ${C.border};border-radius:${radius.md};background:rgba(161,161,170,.05)}',
    '    .${L}-co summary{padding:8px 10px;color:${C.textMuted};font-size:${size.sm};cursor:pointer;user-select:none}',
    '    .${L}-co[open] summary{border-bottom:1px solid ${C.border}}',
    '    .${L}-cr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:10px}',
    '    .${L}-cs{min-width:0;height:34px;border:1px solid ${C.border};border-radius:${radius.md};background:${C.surface};color:${C.text};padding:0 8px;font:inherit}',
    '    .${L}-cb{height:34px;padding:0 12px;border:1px solid rgba(96,165,250,.55);border-radius:${radius.md};background:rgba(59,130,246,.16);color:#bfdbfe;cursor:pointer;font-size:${size.sm};font-weight:600;white-space:nowrap}',
    '    .${L}-cb:disabled{opacity:.4;cursor:default}',
  ].join('\n')
  const attachmentHtmlNeedle = [
    '      <div class="${L}-ia">',
    '        <div class="${L}-ir">',
    '          <textarea class="${L}-in" placeholder="Describe the change..." rows="1"></textarea>',
    '          <button class="${L}-sb"><span class="${L}-st"><i class="icon-arrow-up"></i></span><div class="${L}-sp"></div></button>',
    '        </div>',
    '      </div>',
  ].join('\n')
  const attachmentHtml = [
    '      <div class="${L}-ia">',
    '        <div class="${L}-ir">',
    '          <textarea class="${L}-in" placeholder="Describe the change..." rows="1"></textarea>',
    '          <button class="${L}-sb"><span class="${L}-st"><i class="icon-arrow-up"></i></span><div class="${L}-sp"></div></button>',
    '        </div>',
    '        <div class="${L}-ar">',
    '          <button type="button" class="${L}-ab" title="上传参考图"><i class="icon-image"></i><span>上传参考图</span></button>',
    '          <div class="${L}-ah">点击上传或在输入框按 Ctrl+V 粘贴图片；可结合文字说明，在选定区块的上、下、左、右追加或还原参考图内容。</div>',
    '          <input class="${L}-af" type="file" accept="image/png,image/jpeg,image/webp" hidden>',
    '          <div class="${L}-al"></div>',
    '        </div>',
    '      </div>',
    '      <details class="${L}-co">',
    '        <summary>约束替换（可选）</summary>',
    '        <div class="${L}-cr">',
    '          <select class="${L}-cs" aria-label="选择约束替换"><option value="">请选择约束…</option></select>',
    '          <button type="button" class="${L}-cb" disabled>替换选中元素</button>',
    '        </div>',
    '      </details>',
  ].join('\n')
  const attachmentHelpersNeedle = '    async function sendEdit() {'
  const attachmentHelpers = [
    '    function clearEditAttachments2() {',
    '      app2.attachments = [];',
    '      if (app2.attachmentInputEl) app2.attachmentInputEl.value = "";',
    '      if (app2.attachmentListEl) app2.attachmentListEl.replaceChildren();',
    '    }',
    '    function renderEditAttachments2() {',
    '      const list = app2.attachmentListEl;',
    '      if (!list) return;',
    '      list.replaceChildren();',
    '      for (const item of app2.attachments || []) {',
    '        const chip = document.createElement("div");',
    '        chip.className = `${L4}-ac`;',
    '        const image = document.createElement("img");',
    '        image.src = `data:${item.mimeType};base64,${item.base64}`;',
    '        image.alt = "";',
    '        const name = document.createElement("span");',
    '        name.textContent = item.name;',
    '        const remove = document.createElement("button");',
    '        remove.type = "button";',
    '        remove.className = `${L4}-ad`;',
    '        remove.title = "移除参考图";',
    '        remove.textContent = "×";',
    '        remove.addEventListener("click", clearEditAttachments2);',
    '        chip.append(image, name, remove);',
    '        list.appendChild(chip);',
    '      }',
    '    }',
    '    async function addEditAttachment2(file) {',
    '      if (!file) return;',
    '      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {',
    '        toast2("请选择 PNG、JPG 或 WebP 图片", "error");',
    '        return;',
    '      }',
    '      if (file.size > 2 * 1024 * 1024) {',
    '        toast2("参考图不能超过 2 MB", "error");',
    '        return;',
    '      }',
    '      const dataUrl = await new Promise((resolve, reject) => {',
    '        const reader = new FileReader();',
    '        reader.onload = () => resolve(String(reader.result || ""));',
    '        reader.onerror = () => reject(new Error("参考图读取失败"));',
    '        reader.readAsDataURL(file);',
    '      });',
    '      const base64 = String(dataUrl).split(",", 2)[1] || "";',
    '      if (!base64) { toast2("参考图读取失败", "error"); return; }',
    '      app2.attachments = [{ name: file.name.slice(0, 120), mimeType: file.type, base64 }];',
    '      renderEditAttachments2();',
    '    }',
    attachmentHelpersNeedle,
  ].join('\n')
  const replacements = [
    [
      '      backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2);',
      '      backdrop-filter:none;-webkit-backdrop-filter:none;backface-visibility:hidden;',
    ],
    [
      '      box-shadow:${shadow.lg};',
      '      box-shadow:0 6px 18px rgba(0,0,0,.32);',
    ],
    [
      '      transition:box-shadow .12s,border-color .12s;',
      '      transition:border-color .12s;',
    ],
    [
      '    .${L}-panel{\n      display:none;width:320px;max-height:280px;overflow-y:auto;',
      '    .${L}-panel{\n      display:none;width:min(640px,calc(100vw - 32px));max-height:min(560px,calc(100vh - 88px));overflow-y:auto;',
    ],
    [
      '    #${L}-bar.expanded{overflow:hidden;border-radius:14px}',
      '    #${L}-bar.expanded{overflow:hidden;border-radius:14px;left:auto!important;top:auto!important;right:16px!important;bottom:16px!important;max-height:calc(100vh - 32px)}',
    ],
    [
      '      min-height:30px;max-height:72px;',
      '      min-height:240px;max-height:480px;',
    ],
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
    [attachmentCssNeedle, attachmentCss],
    [attachmentHtmlNeedle, attachmentHtml],
    [
      '      sendBtnEl: null,\n        pollTimer: null,',
      '      sendBtnEl: null,\n        attachments: [],\n        attachmentInputEl: null,\n        attachmentListEl: null,\n        constraintSelectEl: null,\n        constraintButtonEl: null,\n        pollTimer: null,',
    ],
    [attachmentHelpersNeedle, attachmentHelpers],
    [
      '      const instruction = input.value.trim();\n      if (!instruction) return;',
      '      const typedInstruction = input.value.trim();\n      const constraintIndex = Number(app2.constraintSelectEl?.value);\n      const constraint = app2.constraintSelectEl?.value !== "" && Number.isInteger(constraintIndex) ? (window.__QP_LAYRR_CONSTRAINTS__ || [])[constraintIndex] : undefined;\n      const instruction = typedInstruction || (constraint ? `使用约束“${constraint.name}”替换选中元素` : app2.attachments?.length ? "请根据附件参考图修改选中元素，尽量还原图片中与选中区域相关的内容和样式。" : "");\n      if (!instruction) return;',
    ],
    [
      'instruction, sourceInfo }));',
      'instruction, sourceInfo, attachments: app2.attachments, constraint }));',
    ],
    [
      '          instruction,\n          sourceInfo,\n          elements: resolvedElements',
      '          instruction,\n          sourceInfo,\n          attachments: app2.attachments,\n          constraint,\n          elements: resolvedElements',
    ],
    [
      '      app2.sendBtnEl = panel.querySelector(`.${L4}-sb`);',
      '      app2.sendBtnEl = panel.querySelector(`.${L4}-sb`);\n      app2.attachmentInputEl = panel.querySelector(`.${L4}-af`);\n      app2.attachmentListEl = panel.querySelector(`.${L4}-al`);\n      app2.constraintSelectEl = panel.querySelector(`.${L4}-cs`);\n      app2.constraintButtonEl = panel.querySelector(`.${L4}-cb`);\n      app2.attachments = [];\n      const constraintGroups = { global: document.createElement("optgroup"), page: document.createElement("optgroup") };\n      constraintGroups.global.label = "全局约束";\n      constraintGroups.page.label = "页面约束";\n      for (const [index, item] of (window.__QP_LAYRR_CONSTRAINTS__ || []).entries()) {\n        const option = document.createElement("option");\n        option.value = String(index);\n        option.textContent = item.name;\n        constraintGroups[item.scope === "page" ? "page" : "global"].appendChild(option);\n      }\n      if (constraintGroups.global.children.length) app2.constraintSelectEl?.appendChild(constraintGroups.global);\n      if (constraintGroups.page.children.length) app2.constraintSelectEl?.appendChild(constraintGroups.page);',
    ],
    [
      '      app2.sendBtnEl.addEventListener("click", sendEdit);',
      '      app2.sendBtnEl.addEventListener("click", sendEdit);\n      app2.constraintSelectEl?.addEventListener("change", () => {\n        if (app2.constraintButtonEl) app2.constraintButtonEl.disabled = app2.constraintSelectEl.value === "";\n      });\n      app2.constraintButtonEl?.addEventListener("click", () => {\n        if (!app2.selectedEl) { toast2("请先选择需要替换的元素", "error"); return; }\n        void sendEdit();\n      });\n      panel.querySelector(`.${L4}-ab`)?.addEventListener("click", () => app2.attachmentInputEl?.click());\n      app2.attachmentInputEl?.addEventListener("change", () => {\n        const file = app2.attachmentInputEl?.files?.[0];\n        if (file) void addEditAttachment2(file).catch((error) => toast2(error.message || "参考图读取失败", "error"));\n      });\n      panel.addEventListener("paste", (event) => {\n        const imageItem = Array.from(event.clipboardData?.items || []).find((item) => item.kind === "file" && ["image/png", "image/jpeg", "image/webp"].includes(item.type));\n        const file = imageItem?.getAsFile();\n        if (!file) return;\n        event.preventDefault();\n        void addEditAttachment2(file).catch((error) => toast2(error.message || "参考图读取失败", "error"));\n      });',
    ],
    [
      '      if (msg.success) {\n        app2.editCount++;',
      '      if (msg.success) {\n        clearEditAttachments2();\n        if (app2.constraintSelectEl) app2.constraintSelectEl.value = "";\n        if (app2.constraintButtonEl) app2.constraintButtonEl.disabled = true;\n        app2.editCount++;',
    ],
    [
      '          input.value = "";\n          input.style.height = "auto";',
      '          input.value = "";\n          input.style.height = "auto";\n          clearEditAttachments2();',
    ],
  ] as const
  for (const [before, after] of replacements) {
    if (adapted.split(before).length !== 2)
      throw new Error(`Layrr 工作区适配不兼容：${before.slice(0, 80)}`)
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
