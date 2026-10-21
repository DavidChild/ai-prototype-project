// Used only by pageTree.preview.config.mjs on the isolated :5187 test origin.
import { db } from '../src/services/storage/db'
import { stylePresets } from '../src/data/stylePresets'
import type { Page } from '../src/types/page'

const id = 'page-tree-preview'
if (!(await db.projects.get(id))) {
  const names = [
    ['menu-a', '投递中心'], ['page-a1', '授权确认', 'menu-a'],
    ['page-a11', '协议明细', 'page-a1'], ['page-a2', '投递通知', 'menu-a'],
    ['menu-b', '投递记录'], ['page-b1', '投递详情', 'menu-b'],
    ['menu-c', '偏好设置'], ['page-c1', '期望工种', 'menu-c'],
  ]
  const pages: Page[] = names.map(([key, name, parentId], sortOrder) => ({
    id: `record-${key}`, projectId: id,
    spec: { id: key!, name: name!, parentId, description: '', blocks: [] },
    sortOrder, genStatus: 'idle', updatedAt: Date.now(),
  }))
  await db.transaction('rw', [db.projects, db.pages], async () => {
    await db.projects.add({ id, name: '页面层级 · 拖拽验证', platform: 'mobile',
      styleSpec: { presetId: stylePresets[0]!.id, tokens: { ...stylePresets[0]!.tokens } },
      analysis: { productName: '层级测试', overview: '', pages: pages.map((p) => p.spec) },
      createdAt: Date.now(), updatedAt: Date.now() })
    await db.pages.bulkAdd(pages)
  })
}
await import('../src/main')
