import type { Page } from '../types/page'

export type PageDropPosition = 'before' | 'after' | 'inside'

/** Match page names at every depth; include only matches and their ancestor paths. */
export function searchPageTreeRows(
  rows: readonly { page: Page; depth: number }[],
  query: string,
): { rows: { page: Page; depth: number }[]; matchedIds: Set<string> } {
  const keyword = query.trim().toLocaleLowerCase()
  if (!keyword) return { rows: [...rows], matchedIds: new Set() }
  const matchedIds = new Set(
    rows
      .filter(({ page }) => page.spec.name.toLocaleLowerCase().includes(keyword))
      .map(({ page }) => page.spec.id),
  )
  const included = new Set<number>()
  const ancestors: number[] = []
  rows.forEach(({ page, depth }, index) => {
    while (ancestors.length && rows[ancestors.at(-1)!]!.depth >= depth) ancestors.pop()
    if (matchedIds.has(page.spec.id)) {
      included.add(index)
      for (const ancestor of ancestors) included.add(ancestor)
    }
    ancestors.push(index)
  })
  return { rows: rows.filter((_, index) => included.has(index)), matchedIds }
}

/** Hide descendants only; folding must never change the underlying tree or drag payload. */
export function visiblePageTreeRows(
  rows: readonly { page: Page; depth: number }[],
  collapsed: ReadonlySet<string>,
): { page: Page; depth: number }[] {
  let hiddenBelow: number | undefined
  return rows.filter(({ page, depth }) => {
    if (hiddenBelow !== undefined && depth > hiddenBelow) return false
    hiddenBelow = collapsed.has(page.spec.id) ? depth : undefined
    return true
  })
}

/** Preorder traversal keeps each menu adjacent to all of its descendants. */
export function pageTreeRows(pages: readonly Page[]): { page: Page; depth: number }[] {
  const ids = new Set(pages.map((page) => page.spec.id))
  const children = new Map<string | undefined, Page[]>()
  for (const page of pages) {
    const parent = ids.has(page.spec.parentId ?? '') ? page.spec.parentId : undefined
    const siblings = children.get(parent) ?? []
    siblings.push(page)
    children.set(parent, siblings)
  }
  const rows: { page: Page; depth: number }[] = []
  const visited = new Set<string>()
  const visit = (page: Page, depth: number) => {
    if (visited.has(page.spec.id)) return
    visited.add(page.spec.id)
    rows.push({ page, depth })
    for (const child of children.get(page.spec.id) ?? []) visit(child, depth + 1)
  }
  for (const root of children.get(undefined) ?? []) visit(root, 0)
  // Keep legacy orphaned/cyclic records visible rather than losing them.
  for (const page of pages) visit(page, 0)
  return rows
}

export function pageSubtreeIds(pages: readonly Page[], pageId: string): Set<string> {
  const source = pages.find((page) => page.id === pageId)
  const ids = new Set<string>()
  if (!source) return ids
  ids.add(source.spec.id)
  let changed = true
  while (changed) {
    changed = false
    for (const page of pages) {
      if (page.spec.parentId && ids.has(page.spec.parentId) && !ids.has(page.spec.id)) {
        ids.add(page.spec.id)
        changed = true
      }
    }
  }
  return ids
}

/** A null target moves the whole subtree to the end of the root menu. */
export function movePageTree(
  pages: readonly Page[],
  pageId: string,
  targetId: string | null,
  position: PageDropPosition,
): Page[] {
  const source = pages.find((page) => page.id === pageId)
  const target = targetId === null ? undefined : pages.find((page) => page.id === targetId)
  if (!source || (targetId !== null && !target)) throw new Error('页面不存在，请刷新后重试')
  if (target && target.projectId !== source.projectId) throw new Error('不能跨项目移动页面')
  const subtreeIds = pageSubtreeIds(pages, pageId)
  if (target && subtreeIds.has(target.spec.id)) throw new Error('不能移动到自身或自己的下级页面')
  const ordered = pageTreeRows(pages).map(({ page }) => page)
  const subtree = ordered.filter((page) => subtreeIds.has(page.spec.id))
  const remaining = ordered.filter((page) => !subtreeIds.has(page.spec.id))
  const validSpecIds = new Set(remaining.map((page) => page.spec.id))
  const parentId = target
    ? position === 'inside'
      ? target.spec.id
      : validSpecIds.has(target.spec.parentId ?? '')
        ? target.spec.parentId
        : undefined
    : undefined
  let index = remaining.length
  if (target) {
    index = remaining.findIndex((page) => page.id === target.id)
    if (position !== 'before') {
      const targetSubtree = pageSubtreeIds(remaining, target.id)
      while (index < remaining.length && targetSubtree.has(remaining[index]!.spec.id)) index++
    }
  }
  const moved = subtree.map((page) =>
    page.id === pageId ? { ...page, spec: { ...page.spec, parentId } } : page,
  )
  remaining.splice(index, 0, ...moved)
  return remaining.map((page, sortOrder) => ({ ...page, sortOrder }))
}
