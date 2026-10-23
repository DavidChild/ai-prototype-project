export interface HtmlPatch {
  before: string
  after: string
}
export function applyHtmlPatches(html: string, patches: HtmlPatch[], scopes: string[]): string {
  if (!Array.isArray(patches) || !patches.length || patches.length > 12)
    throw new Error('AI 未返回有效局部补丁')
  let result = html
  for (const patch of patches) {
    if (typeof patch.before !== 'string' || !patch.before || typeof patch.after !== 'string')
      throw new Error('补丁格式无效')
    if (!scopes.some((scope) => scope.includes(patch.before)))
      throw new Error('补丁超出选中区域，请重新选择元素')
    const at = result.indexOf(patch.before)
    if (at < 0 || result.indexOf(patch.before, at + patch.before.length) >= 0)
      throw new Error('补丁目标不存在或不唯一，请选择更具体的元素')
    if (patch.after.length > 60000) throw new Error('修改过大，请拆分为局部操作')
    result = result.slice(0, at) + patch.after + result.slice(at + patch.before.length)
  }
  return result
}
