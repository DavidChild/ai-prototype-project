import assert from 'node:assert/strict'
import test from 'node:test'
import { startStorageTest } from './storageTestHarness.mjs'

test('MySQL project iteration copying and isolation', async (t) => {
  const { projectRepo, iterationTaskRepo, pageRepo, versionRepo, docRepo, assetRepo, createProjectBundle, loadWorkbench, connection, counts } = await startStorageTest(t)
  const spec = (id, parentId) => ({ id, parentId, name: id, description: '', blocks: [] })
  const childSpec = { ...spec('child', 'menu'), importedPages: [{ pageId: 'menu-db', access: 'readonly' }] }
  await createProjectBundle({
    id: 'original', name: '项目', platform: 'pc', hidden: false,
    styleSpec: { tokens: { primaryColor: '#123456' } },
    generationConstraints: [{ id: 'constraint', sourcePageId: 'child-db', name: '菜单', html: '<nav>菜单</nav>' }],
    analysis: { productName: '项目', overview: '', pages: [spec('menu'), childSpec] },
    createdAt: 1, updatedAt: 1,
  }, [
    { id: 'menu-db', projectId: 'original', spec: { ...spec('menu'), groupOnly: true }, sortOrder: 0, genStatus: 'idle', updatedAt: 1 },
    { id: 'child-db', projectId: 'original', spec: childSpec, sortOrder: 1, genStatus: 'idle', updatedAt: 1 },
  ], [
    { id: 'doc', projectId: 'original', fileName: '需求', fileType: 'txt', text: '需求内容', meta: {} },
  ], [
    { id: 'asset', docId: 'doc', projectId: 'original', blob: new Blob(['image']), mimeType: 'image/png', origin: 'upload' },
  ])
  await versionRepo.add('child-db', '<p>旧内容</p>', 'generate', undefined, 'html-v1')
  await versionRepo.add('child-db', '<p>当前内容</p>', 'refine', undefined, 'html-v2')
  await t.test('defaults and original HTML are preserved', async () => {
    const original = await projectRepo.get('original')
    assert.equal(original.familyId, 'original')
    assert.equal(original.iteration, 'v1.0')
    assert.equal((await loadWorkbench('original')).htmlByPage.get('child-db'), '<p>当前内容</p>')
  })
  await t.test('iteration task retains AI session id and conversation for continuation', async () => {
    const now = Date.now()
    const created = await iterationTaskRepo.create({
      id: 'iteration-task', title: '多端迭代', status: 'pending', primarySourceId: 'original',
      requirementText: '同步版本需求', documents: [], images: [], createdAt: now, updatedAt: now,
      endpoints: [{
        sourceProjectId: 'original', sourceFamilyId: 'original', projectName: '项目',
        sourceIteration: 'v1.0', targetIteration: 'v1.1', generationProviderId: 'provider',
        generationModel: 'model', status: 'pending',
        aiSession: {
          id: 'ai-session-stable', providerId: 'provider', model: 'model',
          continuationMode: 'history-replay', system: 'system',
          messages: [{ role: 'user', content: '初始需求' }], updatedAt: now,
        },
      }],
    })
    created.status = 'failed'
    created.endpoints[0].status = 'failed'
    created.endpoints[0].aiSession.messages.push({ role: 'assistant', content: '已完成部分规划' })
    const saved = await iterationTaskRepo.save(created)
    const listed = (await iterationTaskRepo.list()).find((task) => task.id === created.id)
    const summary = (await iterationTaskRepo.listSummaries()).find((task) => task.id === created.id)
    assert.equal(saved.endpoints[0].aiSession.id, 'ai-session-stable')
    assert.equal(listed.endpoints[0].aiSession.messages[1].content, '已完成部分规划')
    assert.equal(summary.requirementText, '')
    assert.equal(summary.endpoints[0].aiSession.system, '')
    assert.deepEqual(summary.endpoints[0].aiSession.messages, [])
    await iterationTaskRepo.remove(created.id)
    assert.equal((await iterationTaskRepo.list()).some((task) => task.id === created.id), false)
  })
  await t.test('hidden projects cannot be added to a new iteration task', async () => {
    await projectRepo.updateFamily('original', { hidden: true })
    const now = Date.now()
    await assert.rejects(
      iterationTaskRepo.create({
        id: 'hidden-project-task', title: '隐藏项目迭代', status: 'pending',
        primarySourceId: 'original', requirementText: '不应创建', documents: [], images: [],
        createdAt: now, updatedAt: now,
        endpoints: [{
          sourceProjectId: 'original', sourceFamilyId: 'original', projectName: '项目',
          sourceIteration: 'v1.0', targetIteration: 'v1.1', generationProviderId: 'provider',
          generationModel: 'model', status: 'pending',
          aiSession: {
            id: 'hidden-project-session', providerId: 'provider', model: 'model',
            continuationMode: 'history-replay', system: '', messages: [], updatedAt: now,
          },
        }],
      }),
      /隐藏项目不能加入多端迭代任务/,
    )
    await projectRepo.updateFamily('original', { hidden: false })
  })
  let copied
  await t.test('copy preserves tree, history, HTML, assets and remaps database references', async () => {
    copied = await projectRepo.copyIteration('original', ' v1.1 ')
    assert.equal(copied.iteration, 'v1.1')
    assert.equal(copied.basedOnId, 'original')
    const data = await loadWorkbench(copied.id)
    assert.equal(data.pages.length, 2)
    assert.notEqual(data.pages[0].id, 'menu-db')
    assert.equal(data.pages[1].spec.parentId, data.pages[0].spec.id)
    assert.equal(data.pages[0].spec.groupOnly, true)
    assert.equal(data.pages[1].spec.importedPages[0].pageId, data.pages[0].id)
    assert.equal(copied.generationConstraints[0].sourcePageId, data.pages[1].id)
    assert.deepEqual(copied.analysis.pages, data.pages.map((page) => page.spec))
    assert.equal(data.htmlByPage.get(data.pages[1].id), '<p>当前内容</p>')
    const history = await versionRepo.listByPage(data.pages[1].id)
    assert.equal(history.length, 2)
    assert.ok(history.every((v) => !['html-v1', 'html-v2'].includes(v.id)))
    const [doc] = await docRepo.listByProject(copied.id)
    const [asset] = await assetRepo.listByProject(copied.id)
    assert.notEqual(doc.id, 'doc')
    assert.equal(asset.docId, doc.id)
    assert.equal(await asset.blob.text(), 'image')
  })
  let planned
  await t.test('requirement-led copy creates a baseline plus isolated update and new-page tasks', async () => {
    planned = await projectRepo.copyIteration('original', 'v1.2', {
      text: '订单列表增加跨端一致的状态展示，并新增订单详情页。',
      documents: [{ fileName: 'v1.2需求.txt', fileType: 'txt', text: '状态规则', meta: {} }],
      relatedPages: [{ projectId: 'mobile-v1', projectName: '移动端项目', iteration: 'v1.0', platform: 'mobile', pageId: 'mobile-order', pageName: '订单', description: '移动订单页', blocks: ['订单卡片'] }],
      plan: {
        productNature: '企业订单 B 端 PC 管理后台',
        summary: '更新列表并新增详情',
        changes: [
          { action: 'update', sourcePageId: 'child-db', name: 'child', description: '增加状态', blocks: ['状态筛选', '列表'], reason: '旧列表可承载', relatedPageIds: ['mobile-order'] },
          { action: 'create', parentSourcePageId: 'menu-db', name: '订单详情', description: '查看订单详情', blocks: ['订单信息'], reason: '旧版本没有详情页', relatedPageIds: ['mobile-order'] },
        ],
      },
    })
    assert.equal(planned.iterationRequirement.sourceIteration, 'v1.0')
    assert.equal(planned.iterationRequirement.productNature, '企业订单 B 端 PC 管理后台')
    assert.equal(planned.iterationRequirement.relatedPages[0].pageId, 'mobile-order')
    const data = await loadWorkbench(planned.id)
    assert.equal(data.pages.length, 3)
    const updated = data.pages.find((page) => page.spec.iterationChange?.action === 'update')
    const created = data.pages.find((page) => page.spec.iterationChange?.action === 'create')
    const menu = data.pages.find((page) => page.spec.groupOnly)
    assert.equal(updated.genStatus, 'idle')
    assert.equal(updated.iterationInitialized, false)
    assert.equal(data.htmlByPage.get(updated.id), '<p>当前内容</p>')
    assert.equal(created.genStatus, 'idle')
    assert.match(created.spec.name, /v1\.2/)
    assert.equal(created.spec.parentId, menu.spec.id)
    const history = await versionRepo.listByPage(updated.id)
    assert.equal(history.length, 3)
    assert.equal(history[0].source, 'copy')
    assert.match(history[0].feedbackText, /旧版本 v1\.0 基线/)
    const copiedDocs = await docRepo.listByProject(planned.id)
    assert.ok(copiedDocs.some((doc) => doc.fileName === 'v1.2需求.txt' && doc.meta.iterationRequirement))
    assert.equal((await loadWorkbench('original')).htmlByPage.get('child-db'), '<p>当前内容</p>')
  })
  await t.test('continued conversation applies a new plan to the existing target version', async () => {
    const before = await loadWorkbench(planned.id)
    const existingCreated = before.pages.find((page) => page.spec.iterationChange?.action === 'create')
    const adjusted = await projectRepo.applyIterationPlan(planned.id, 'original', {
      text: '继续补充导出能力，并调整原有内容页。', documents: [], relatedPages: [],
      plan: { productNature: '企业订单 B 端 PC 管理后台', summary: '继续调整内容页并新增导出页', changes: [
        { action: 'update', sourcePageId: 'child-db', name: 'child', description: '补充导出入口', blocks: ['列表', '导出'], reason: '沿用原页面继续修改', relatedPageIds: [] },
        { action: 'create', parentSourcePageId: 'menu-db', name: '导出记录', description: '查看导出任务', blocks: ['任务列表'], reason: '补充要求新增页面', relatedPageIds: [] },
      ] },
    })
    assert.equal(adjusted.id, planned.id)
    const after = await loadWorkbench(planned.id)
    const updated = after.pages.find((page) => page.spec.id === 'child')
    assert.equal(updated.iterationInitialized, false)
    assert.equal(updated.spec.iterationChange.reason, '沿用原页面继续修改')
    assert.ok(after.pages.some((page) => page.spec.name === '导出记录'))
    assert.ok(after.pages.some((page) => page.id === existingCreated.id), 'unrelated existing pages are preserved')
  })
  await t.test('editing a copied iteration leaves the source unchanged', async () => {
    const child = (await pageRepo.listByProject(copied.id))[1]
    await pageRepo.rename(child.id, '新名称')
    await versionRepo.add(child.id, '<p>新版本独立内容</p>', 'refine')
    assert.equal((await pageRepo.get('child-db')).spec.name, 'child')
    assert.equal((await projectRepo.get('original')).analysis.pages[1].name, 'child')
    assert.equal((await loadWorkbench('original')).htmlByPage.get('child-db'), '<p>当前内容</p>')
    const branch = await projectRepo.copyIteration(copied.id, 'v2.0')
    assert.equal(branch.basedOnId, copied.id)
    assert.equal((await pageRepo.listByProject(branch.id))[1].spec.name, '新名称')
  })
  await t.test('invalid or actively generating sources are rejected atomically', async () => {
    const before = await counts()
    await assert.rejects(projectRepo.copyIteration('original', ' '), /版本号/)
    await assert.rejects(projectRepo.copyIteration('original', 'V1.1'), /已存在/)
    await assert.rejects(projectRepo.copyIteration('missing', 'v3.0'), /不存在/)
    await pageRepo.update('child-db', { genStatus: 'generating' })
    await assert.rejects(projectRepo.copyIteration('original', 'v3.0'), /仍在生成/)
    assert.deepEqual(await counts(), before)
    await pageRepo.update('child-db', { genStatus: 'done' })
  })
  await t.test('concurrent copies cannot create duplicate iteration labels', async () => {
    const results = await Promise.allSettled([projectRepo.copyIteration('original', 'v3.0'), projectRepo.copyIteration('original', 'v3.0')])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1)
  })
  await t.test('asset failure rolls back the complete iteration', async () => {
    const before = await counts()
    await connection.query("CREATE TRIGGER fail_copy_asset BEFORE INSERT ON assets FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected asset failure'")
    try {
      await assert.rejects(projectRepo.copyIteration('original', 'failed-copy'), /injected asset failure/)
    } finally {
      await connection.query('DROP TRIGGER fail_copy_asset')
    }
    assert.deepEqual(await counts(), before)
  })
  await t.test('multi-endpoint iteration creation rolls every endpoint back when one fails', async () => {
    const before = await counts()
    await assert.rejects(projectRepo.copyIterations([
      { sourceId: 'original', iteration: 'v4.0', requirement: undefined },
      { sourceId: 'original', iteration: 'V4.0', requirement: undefined },
    ]), /已存在/)
    assert.deepEqual(await counts(), before)
    assert.equal((await projectRepo.list()).some((project) => project.iteration?.toLowerCase() === 'v4.0'), false)
  })
  await t.test('family name and visibility apply to every iteration', async () => {
    const profile = await projectRepo.updateProfile(copied.id, {
      nature: '企业/B 端 PC 管理后台',
      purpose: '供企业员工处理订单与状态流转。',
    })
    assert.equal(profile.nature, '企业/B 端 PC 管理后台')
    assert.ok((await projectRepo.list()).every((p) => p.endpointProfile?.purpose === profile.purpose))
    await projectRepo.updateFamily('original', { name: '重命名项目', hidden: true })
    assert.ok((await projectRepo.list()).every((p) => p.hidden && p.name === '重命名项目'))
    await projectRepo.updateFamily('original', { hidden: false })
  })
  await t.test('cancelling a task can keep or delete versions created by that task', async () => {
    const taskValue = (id, targetProjectId, targetIteration) => ({
      id, title: id, status: 'failed', primarySourceId: 'original', requirementText: '需求',
      documents: [], images: [], createdAt: Date.now(), updatedAt: Date.now(),
      endpoints: [{
        sourceProjectId: 'original', sourceFamilyId: 'original', projectName: '项目',
        sourceIteration: 'v1.0', targetIteration, targetProjectId,
        generationProviderId: 'provider', generationModel: 'model', status: 'failed',
        aiSession: { id: `${id}-session`, providerId: 'provider', model: 'model', continuationMode: 'history-replay', system: '', messages: [], updatedAt: Date.now() },
      }],
    })
    const keptTask = await iterationTaskRepo.create(taskValue('keep-task', copied.id, copied.iteration))
    const kept = await iterationTaskRepo.cancel(keptTask.id, false)
    assert.equal(kept.cancelMode, 'keep-versions')
    assert.ok((await projectRepo.list()).some((project) => project.id === copied.id))

    const disposable = await projectRepo.copyIteration('original', 'v9.0')
    const deleteTask = await iterationTaskRepo.create(taskValue('delete-task', disposable.id, disposable.iteration))
    const cancelled = await iterationTaskRepo.cancel(deleteTask.id, true)
    assert.equal(cancelled.cancelMode, 'delete-versions')
    assert.equal((await projectRepo.list()).some((project) => project.id === disposable.id), false)
  })
  await t.test('removing one iteration preserves the rest of the project family', async () => {
    const before = await counts()
    const removedPageCount = (await pageRepo.listByProject(copied.id)).length
    await projectRepo.removeCascade(copied.id)
    assert.equal((await projectRepo.list()).some((project) => project.id === copied.id), false)
    assert.ok(await projectRepo.get('original'))
    const after = await counts()
    assert.equal(after.projects, before.projects - 1)
    assert.equal(after.pages, before.pages - removedPageCount)
  })
  await t.test('family removal cascades to pages, histories, docs and assets', async () => {
    await projectRepo.create({ id: 'other', name: '另一个项目', createdAt: 1, updatedAt: 1 })
    assert.equal((await projectRepo.get('other')).iteration, 'v1.0')
    await projectRepo.removeFamily('original')
    assert.deepEqual((await projectRepo.list()).map((p) => p.id), ['other'])
    assert.deepEqual(await counts(), { projects: 1, pages: 0, page_versions: 0, source_docs: 0, assets: 0 })
  })
})
