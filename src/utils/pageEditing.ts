import type { Page } from '../types/page'

/** 只锁定导航分组类型，不影响名称、描述和层级等其他字段。 */
export function pageTypeLockReason(page: Page, hasHtml = false): string {
  if (page.currentVersionId || hasHtml || page.genStatus === 'done') {
    return '当前页面已生成，不可修改菜单类型'
  }
  if (page.genStatus === 'queued' || page.genStatus === 'generating') {
    return '当前页面正在排队或生成，请先停止生成再修改菜单类型'
  }
  return ''
}
