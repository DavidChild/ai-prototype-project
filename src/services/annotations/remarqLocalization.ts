/** Localize the pinned web-remarq runtime without modifying node_modules. */
export function adaptWebRemarqRuntime(source: string): string {
  let adapted = source
  const translations = [
    ['inspect: `Inspect element (${modKey}+I)`', 'inspect: `选取元素 (${modKey}+I)`', 1],
    ['spacing: "Spacing overlay (S)"', 'spacing: "查看元素间距 (S)"', 1],
    ['copy: "Copy as Markdown (C)"', 'copy: "复制全部标注 (C)"', 1],
    ['export: "Export"', 'export: "导出标注"', 1],
    ['import: "Import JSON"', 'import: "导入标注 JSON"', 1],
    ['clear: "Clear all"', 'clear: "清除全部标注"', 1],
    ['theme: "Toggle theme"', 'theme: "切换明暗主题"', 1],
    ['help: "Keyboard shortcuts (?)"', 'help: "快捷键帮助 (?)"', 1],
    ['minimize: "Minimize"', 'minimize: "收起工具栏"', 1],
    ['submit: "Submit drafts to agent"', 'submit: "提交草稿给 AI"', 1],
    ['textarea.placeholder = "Add your comment...";', 'textarea.placeholder = "请输入原型标注说明…";', 1],
    ['hint.textContent = "Enter to submit \\xB7 Shift+Enter for new line";', 'hint.textContent = "Enter 保存 · Shift+Enter 换行";', 1],
    ['cancelBtn.textContent = "Cancel";', 'cancelBtn.textContent = "取消";', 1],
    ['addBtn.textContent = "Add";', 'addBtn.textContent = "保存标注";', 1],
    ['el.title = "Click to edit";', 'el.title = "点击编辑标注";', 1],
    ['restored.title = "Click to edit";', 'restored.title = "点击编辑标注";', 1],
    ['summary.textContent = `History (${lifecycle.length})`;', 'summary.textContent = `变更历史（${lifecycle.length}）`;', 1],
    ['copyBtn.textContent = "Copy";', 'copyBtn.textContent = "复制";', 1],
    ['deleteBtn.textContent = "Delete";', 'deleteBtn.textContent = "删除";', 1],
    ['closeBtn.textContent = "Close";', 'closeBtn.textContent = "关闭";', 1],
    ['cancel.textContent = "Cancel";', 'cancel.textContent = "取消";', 1],
    ['submit.textContent = "Submit";', 'submit.textContent = "提交";', 1],
    ['textarea.placeholder = `Reason for ${def.label.toLowerCase()} (optional)\\u2026`;', 'textarea.placeholder = `请输入${def.label}原因（可选）…`;', 1],
    ['description: "Toggle inspect mode"', 'description: "开启/关闭元素选取"', 1],
    ['description: "Toggle spacing overlay"', 'description: "开启/关闭间距查看"', 1],
    ['description: "Copy all annotations to clipboard"', 'description: "复制全部标注到剪贴板"', 1],
    ['description: "Delete all annotations"', 'description: "清除全部标注"', 1],
    ['description: "Exit inspect mode / close popup"', 'description: "退出元素选取 / 关闭弹窗"', 1],
    ['description: "Show this help"', 'description: "显示快捷键帮助"', 1],
    ['description: "Submit annotation"', 'description: "保存标注"', 1],
    ['description: "New line"', 'description: "换行"', 1],
    ['context: "inspect"', 'context: "元素选取时"', 1],
    ['context: "popup"', 'context: "标注弹窗中"', 2],
    ['title.textContent = "Keyboard Shortcuts";', 'title.textContent = "快捷键帮助";', 1],
    ['mdBtn.textContent = "MD (file)";', 'mdBtn.textContent = "Markdown 文件";', 1],
    ['jsonBtn.textContent = "JSON (file)";', 'jsonBtn.textContent = "JSON 文件";', 1],
    ['showToast(themeManager.container, "Exported as Markdown");', 'showToast(themeManager.container, "已导出 Markdown 标注");', 1],
    ['showToast(themeManager.container, "Exported as JSON");', 'showToast(themeManager.container, "已导出 JSON 标注");', 1],
    ['showToast(themeManager.container, "No annotations to copy");', 'showToast(themeManager.container, "当前没有可复制的标注");', 1],
    ['showToast(themeManager.container, "Copied to clipboard");', 'showToast(themeManager.container, "标注已复制到剪贴板");', 2],
    ['showToast(themeManager.container, "Failed to copy");', 'showToast(themeManager.container, "复制失败，请重试");', 1],
  ] as const
  for (const [before, after, expected] of translations) {
    const count = adapted.split(before).length - 1
    if (count !== expected)
      throw new Error(
        `web-remarq 中文适配不兼容：${before}（期望 ${expected} 处，实际 ${count} 处）`,
      )
    adapted = adapted.split(before).join(after)
  }
  return adapted
}
