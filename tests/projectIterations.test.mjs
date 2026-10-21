import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import Dexie from 'dexie'
import { createJiti } from 'jiti'
import { fileURLToPath } from 'node:url'

test('project iteration migration, copying and isolation', async (t) => {
  const legacy = new Dexie('quickpage')
  legacy.version(1).stores({
    projects: 'id, updatedAt',
    pages: 'id, projectId, [projectId+sortOrder]',
    pageVersions: 'id, pageId, [pageId+versionNumber], createdAt',
    sourceDocs: 'id, projectId',
    assets: 'id, projectId, docId',
  })
  const spec = (id, parentId) => ({ id, parentId, name: id, description: '', blocks: [] })
  await legacy.table('projects').add({
    id: 'original',
    name: '项目',
    platform: 'pc',
    hidden: false,
    styleSpec: { tokens: { primaryColor: '#123456' } },
    analysis: { productName: '项目', overview: '', pages: [spec('menu'), spec('child', 'menu')] },
    createdAt: 1,
    updatedAt: 1,
  })
  await legacy.table('pages').bulkAdd([
    {
      id: 'menu-db',
      projectId: 'original',
      spec: { ...spec('menu'), groupOnly: true },
      sortOrder: 0,
      genStatus: 'idle',
      updatedAt: 1,
    },
    {
      id: 'child-db',
      projectId: 'original',
      spec: spec('child', 'menu'),
      sortOrder: 1,
      genStatus: 'done',
      currentVersionId: 'html-v2',
      updatedAt: 1,
    },
  ])
  await legacy.table('pageVersions').bulkAdd([
    {
      id: 'html-v1',
      pageId: 'child-db',
      html: '<p>旧内容</p>',
      versionNumber: 1,
      source: 'generate',
      createdAt: 1,
    },
    {
      id: 'html-v2',
      pageId: 'child-db',
      html: '<p>当前内容</p>',
      versionNumber: 2,
      source: 'refine',
      createdAt: 2,
    },
  ])
  await legacy
    .table('sourceDocs')
    .add({ id: 'doc', projectId: 'original', fileName: '需求', text: '需求内容', meta: {} })
  await legacy.table('assets').add({
    id: 'asset',
    docId: 'doc',
    projectId: 'original',
    blob: new Blob(['image']),
    mimeType: 'image/png',
    origin: {},
  })
  legacy.close()
  const jiti = createJiti(import.meta.url, {
    alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  })
  const { db } = await jiti.import('../src/services/storage/db.ts')
  const { projectRepo, pageRepo, versionRepo, loadWorkbench } = await jiti.import(
    '../src/services/storage/repositories.ts',
  )
  try {
    await db.open()
    await t.test('legacy data becomes v1.0 without changing IDs or contents', async () => {
      const original = await projectRepo.get('original')
      assert.equal(original.familyId, 'original')
      assert.equal(original.iteration, 'v1.0')
      assert.equal((await loadWorkbench('original')).htmlByPage.get('child-db'), '<p>当前内容</p>')
    })
    let copied
    await t.test('copy preserves tree, history, current HTML and document references', async () => {
      copied = await projectRepo.copyIteration('original', ' v1.1 ')
      assert.equal(copied.iteration, 'v1.1')
      assert.equal(copied.basedOnId, 'original')
      assert.equal(copied.familyId, 'original')
      const data = await loadWorkbench(copied.id)
      assert.equal(data.pages.length, 2)
      assert.notEqual(data.pages[0].id, 'menu-db')
      assert.equal(data.pages[1].spec.parentId, data.pages[0].spec.id)
      assert.equal(data.pages[0].spec.groupOnly, true)
      assert.equal(data.pages[1].genStatus, 'done')
      assert.equal(data.htmlByPage.get(data.pages[1].id), '<p>当前内容</p>')
      const history = await versionRepo.listByPage(data.pages[1].id)
      assert.equal(history.length, 2)
      assert.ok(history.every((v) => !['html-v1', 'html-v2'].includes(v.id)))
      const doc = await db.sourceDocs.where('projectId').equals(copied.id).first()
      const asset = await db.assets.where('projectId').equals(copied.id).first()
      assert.notEqual(doc.id, 'doc')
      assert.equal(asset.docId, doc.id)
      assert.equal(await asset.blob.text(), 'image')
    })
    await t.test('editing and generating a copied version leave the source unchanged', async () => {
      const child = (await pageRepo.listByProject(copied.id))[1]
      await pageRepo.rename(child.id, '新名称')
      await versionRepo.add(child.id, '<p>新版本独立内容</p>', 'refine')
      assert.equal((await pageRepo.get('child-db')).spec.name, 'child')
      assert.equal((await projectRepo.get('original')).analysis.pages[1].name, 'child')
      assert.equal((await loadWorkbench('original')).htmlByPage.get('child-db'), '<p>当前内容</p>')
      assert.equal((await versionRepo.listByPage('child-db')).length, 2)
      const branch = await projectRepo.copyIteration(copied.id, 'v2.0')
      assert.equal(branch.basedOnId, copied.id)
      assert.equal((await pageRepo.listByProject(branch.id))[1].spec.name, '新名称')
    })
    await t.test(
      'blank, duplicate, missing and actively generating sources are rejected atomically',
      async () => {
        const count = await db.projects.count()
        await assert.rejects(projectRepo.copyIteration('original', ' '), /版本号/)
        await assert.rejects(projectRepo.copyIteration('original', 'V1.1'), /已存在/)
        await assert.rejects(projectRepo.copyIteration('missing', 'v3.0'), /不存在/)
        await pageRepo.update('child-db', { genStatus: 'generating' })
        await assert.rejects(projectRepo.copyIteration('original', 'v3.0'), /仍在生成/)
        assert.equal(await db.projects.count(), count)
        await pageRepo.update('child-db', { genStatus: 'done' })
      },
    )
    await t.test('concurrent copies cannot create duplicate version labels', async () => {
      const results = await Promise.allSettled([
        projectRepo.copyIteration('original', 'v3.0'),
        projectRepo.copyIteration('original', 'v3.0'),
      ])
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
      assert.equal(results.filter((r) => r.status === 'rejected').length, 1)
    })
    await t.test('a copy failure rolls back all tables', async () => {
      const tables = [db.projects, db.pages, db.pageVersions, db.sourceDocs, db.assets]
      const counts = await Promise.all(tables.map((table) => table.count()))
      const failAsset = () => {
        throw new Error('injected asset failure')
      }
      db.assets.hook('creating', failAsset)
      try {
        await assert.rejects(
          projectRepo.copyIteration('original', 'failed-copy'),
          /injected asset failure/,
        )
      } finally {
        db.assets.hook('creating').unsubscribe(failAsset)
      }
      assert.deepEqual(await Promise.all(tables.map((table) => table.count())), counts)
    })
    await t.test('project visibility and names apply to all iterations', async () => {
      await projectRepo.updateFamily('original', { name: '重命名项目', hidden: true })
      assert.ok((await projectRepo.list()).every((p) => p.hidden && p.name === '重命名项目'))
    })
    await t.test(
      'new projects get v1.0 and deleting a project removes all its iterations',
      async () => {
        await projectRepo.create({ id: 'other', name: '另一个项目', createdAt: 1, updatedAt: 1 })
        assert.equal((await projectRepo.get('other')).iteration, 'v1.0')
        await projectRepo.removeFamily('original')
        assert.deepEqual(
          (await projectRepo.list()).map((p) => p.id),
          ['other'],
        )
        for (const table of [db.pages, db.pageVersions, db.sourceDocs, db.assets])
          assert.equal(await table.count(), 0)
      },
    )
  } finally {
    await db.delete()
  }
})
