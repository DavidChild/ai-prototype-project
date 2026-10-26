import type { Page } from '@/types/page'
import type { Project } from '@/types/project'
import { pageTreeRows } from '@/utils/pageTree'

export interface PrototypeIndexEntry {
  page: Page
  path: readonly string[]
}

interface NavigationNode {
  page: Page
  children: NavigationNode[]
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function fileHref(path: readonly string[]): string {
  return path.map((segment) => encodeURIComponent(segment)).join('/')
}

function navigationTree(allPages: readonly Page[], entries: readonly PrototypeIndexEntry[]) {
  const pagesBySpecId = new Map(allPages.map((page) => [page.spec.id, page]))
  const includedSpecIds = new Set<string>()
  for (const { page } of entries) {
    let current: Page | undefined = page
    const seen = new Set<string>()
    while (current && !seen.has(current.spec.id)) {
      seen.add(current.spec.id)
      includedSpecIds.add(current.spec.id)
      current = current.spec.parentId ? pagesBySpecId.get(current.spec.parentId) : undefined
    }
  }

  const roots: NavigationNode[] = []
  const stack: NavigationNode[] = []
  for (const { page, depth } of pageTreeRows(allPages)) {
    if (!includedSpecIds.has(page.spec.id)) continue
    const node: NavigationNode = { page, children: [] }
    stack.length = Math.min(stack.length, depth)
    const parent = depth > 0 ? stack[depth - 1] : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack[depth] = node
    stack.length = depth + 1
  }
  return roots
}

export function buildPrototypeIndexHtml(
  project: Project,
  allPages: readonly Page[],
  entries: readonly PrototypeIndexEntry[],
): string {
  if (!entries.length) throw new Error('没有可用于生成层级索引的页面')
  const entryByPageId = new Map(entries.map((entry) => [entry.page.id, entry]))
  const roots = navigationTree(allPages, entries)
  const firstEntry = pageTreeRows(allPages)
    .map(({ page }) => entryByPageId.get(page.id))
    .find((entry): entry is PrototypeIndexEntry => !!entry)
  const firstHref = firstEntry ? fileHref(firstEntry.path) : fileHref(entries[0]!.path)

  const renderNodes = (nodes: readonly NavigationNode[], depth = 0): string => `
    <ul class="nav-level nav-level-${depth}">
      ${nodes
        .map((node) => {
          const entry = entryByPageId.get(node.page.id)
          const label = escapeHtml(node.page.spec.name)
          const content = entry
            ? `<a class="page-link" href="${fileHref(entry.path)}" target="prototype-frame">${label}</a>`
            : `<span class="group-label">${label}</span>`
          return `<li>${content}${node.children.length ? renderNodes(node.children, depth + 1) : ''}</li>`
        })
        .join('')}
    </ul>`

  const title = `${project.name} ${project.iteration ?? 'v1.0'} 设计原型（最终以UI效果为准）`
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body { overflow: hidden; color: #18181b; background: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
    header { height: 64px; display: flex; align-items: center; padding: 0 24px; border-bottom: 1px solid #e4e4e7; background: #fff; }
    h1 { margin: 0; overflow: hidden; font-size: 18px; font-weight: 650; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
    .workspace { display: grid; grid-template-columns: 280px minmax(0, 1fr); height: calc(100% - 64px); }
    aside { overflow: auto; padding: 18px 14px 28px; border-right: 1px solid #e4e4e7; background: #fff; }
    .nav-title { margin: 0 8px 12px; color: #71717a; font-size: 12px; font-weight: 600; }
    .nav-level { margin: 0; padding: 0; list-style: none; }
    .nav-level .nav-level { margin: 3px 0 5px 10px; padding-left: 10px; border-left: 1px solid #e4e4e7; }
    .page-link, .group-label { display: block; min-height: 32px; padding: 7px 9px; border-radius: 5px; font-size: 13px; line-height: 18px; }
    .page-link { color: #27272a; text-decoration: none; }
    .page-link:hover { background: #f4f4f5; color: #4f46e5; }
    .page-link.active { background: #eef2ff; color: #4338ca; font-weight: 600; }
    .group-label { color: #52525b; font-weight: 650; }
    main { min-width: 0; min-height: 0; padding: 12px; background: #e4e4e7; }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .08); }
    @media (max-width: 720px) {
      header { height: 56px; padding: 0 16px; }
      h1 { font-size: 15px; }
      .workspace { grid-template-columns: 180px minmax(0, 1fr); height: calc(100% - 56px); }
      aside { padding: 14px 8px 20px; }
      main { padding: 6px; }
    }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(title)}</h1></header>
  <div class="workspace">
    <aside>
      <div class="nav-title">页面层级 · ${entries.length} 个页面</div>
      <nav aria-label="原型页面层级">${renderNodes(roots)}</nav>
    </aside>
    <main><iframe name="prototype-frame" src="${firstHref}" title="原型预览"></iframe></main>
  </div>
  <script>
    const links = Array.from(document.querySelectorAll('.page-link'));
    function activate(link) {
      links.forEach((item) => item.classList.toggle('active', item === link));
    }
    links.forEach((link) => link.addEventListener('click', () => activate(link)));
    const initial = links.find((link) => link.getAttribute('href') === ${JSON.stringify(firstHref)});
    if (initial) activate(initial);
  </script>
</body>
</html>`
}
