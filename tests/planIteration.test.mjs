import assert from 'node:assert/strict'
import test from 'node:test'
import { createJiti } from 'jiti'
import { fileURLToPath } from 'node:url'

const jiti = createJiti(import.meta.url, {
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
})
const { normalizeIterationPlan } = await jiti.import(
  '../src/services/generation/planIteration.ts',
)

test('iteration planning reuses valid old pages and keeps cross-platform references scoped', () => {
  const sourcePages = [
    { id: 'menu-db', spec: { id: 'menu', name: '业务管理', groupOnly: true, description: '', blocks: [] } },
    { id: 'list-db', spec: { id: 'list', parentId: 'menu', name: '订单列表', description: '旧列表', blocks: ['筛选', '表格'] } },
  ]
  const relatedPages = [
    { projectId: 'mobile-v1', projectName: '移动端', iteration: 'v1.0', platform: 'mobile', pageId: 'mobile-order', pageName: '订单', description: '移动端订单', blocks: ['卡片'] },
  ]
  const plan = normalizeIterationPlan({
    productNature: '企业招聘 B 端 PC 管理后台',
    summary: '同步订单状态',
    changes: [
      { action: 'update', sourcePageId: 'list-db', name: '忽略此名', description: '增加状态', blocks: ['筛选', '状态列'], reason: '旧页可承载', relatedPageIds: ['mobile-order', 'missing'] },
      { action: 'update', sourcePageId: 'list-db', name: '重复', description: '', blocks: [], reason: '', relatedPageIds: [] },
      { action: 'update', sourcePageId: 'menu-db', name: '分组', description: '', blocks: [], reason: '', relatedPageIds: [] },
      { action: 'create', name: '订单详情', parentSourcePageId: 'menu-db', description: '详情', blocks: ['信息'], reason: '旧版缺少详情页', relatedPageIds: ['mobile-order'] },
    ],
  }, sourcePages, relatedPages)

  assert.equal(plan.productNature, '企业招聘 B 端 PC 管理后台')
  assert.equal(plan.changes.length, 2)
  assert.deepEqual(plan.changes[0], {
    action: 'update', sourcePageId: 'list-db', parentSourcePageId: undefined,
    name: '订单列表', description: '增加状态', blocks: ['筛选', '状态列'], reason: '旧页可承载', relatedPageIds: ['mobile-order'],
  })
  assert.equal(plan.changes[1].action, 'create')
  assert.equal(plan.changes[1].parentSourcePageId, 'menu-db')
})
