import assert from 'node:assert/strict'
import test from 'node:test'
import { startStorageTest } from './storageTestHarness.mjs'

test('MySQL project iteration copying and isolation', async (t) => {
  const { projectRepo, pageRepo, versionRepo, docRepo, assetRepo, createProjectBundle, loadWorkbench, connection, counts } = await startStorageTest(t)
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
  await t.test('family name and visibility apply to every iteration', async () => {
    await projectRepo.updateFamily('original', { name: '重命名项目', hidden: true })
    assert.ok((await projectRepo.list()).every((p) => p.hidden && p.name === '重命名项目'))
  })
  await t.test('family removal cascades to pages, histories, docs and assets', async () => {
    await projectRepo.create({ id: 'other', name: '另一个项目', createdAt: 1, updatedAt: 1 })
    assert.equal((await projectRepo.get('other')).iteration, 'v1.0')
    await projectRepo.removeFamily('original')
    assert.deepEqual((await projectRepo.list()).map((p) => p.id), ['other'])
    assert.deepEqual(await counts(), { projects: 1, pages: 0, page_versions: 0, source_docs: 0, assets: 0 })
  })
})
