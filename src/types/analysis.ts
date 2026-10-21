export interface PageSpec {
  id: string
  name: string
  /** 上级菜单的 PageSpec.id；为空表示自身是一级菜单 */
  parentId?: string
  /** 仅作为导航分组，不生成页面 */
  groupOnly?: boolean
  description: string
  blocks: string[]
}

export interface RequirementAnalysis {
  productName: string
  overview: string
  targetUsers?: string
  /** 页面树的扁平清单：parentId 为空的是一级菜单；支持工作台调整为多级 */
  pages: PageSpec[]
}
