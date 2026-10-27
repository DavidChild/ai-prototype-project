import assert from 'node:assert/strict'
import test from 'node:test'
import { startStorageTest } from './storageTestHarness.mjs'

test('HTML import initializes only an empty page in the original iteration atomically', async (t) => {
  const { projectRepo, pageRepo, versionRepo } = await startStorageTest(t)
  await projectRepo.create({ id: 'a', name: 'Import test', createdAt: 1, updatedAt: 1 })
  const page = (id, extra = {}) => ({ id, projectId: 'a', spec: { id, name: id, blocks: [], description: '' }, genStatus: 'idle', sortOrder: 0, updatedAt: 0, ...extra })
    await pageRepo.create(page('empty'))
    await assert.rejects(versionRepo.initializeHtml('b', 'empty', '<h1>wrong</h1>'), /项目不存在|迭代/)
    await assert.rejects(versionRepo.initializeHtml('a', 'empty', ' '), /不能为空/)
    const results = await Promise.allSettled([
      versionRepo.initializeHtml('a', 'empty', '<h1>one</h1>'),
      versionRepo.initializeHtml('a', 'empty', '<h1>two</h1>'),
    ])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    const versions = await versionRepo.listByPage('empty')
    assert.equal(versions.length, 1)
    assert.equal(versions[0].source, 'import')
    const saved = await pageRepo.get('empty')
    assert.equal(saved.genStatus, 'done')
    assert.equal(saved.currentVersionId, versions[0].id)
    await pageRepo.create(page('busy', { genStatus: 'generating' }))
    await assert.rejects(versionRepo.initializeHtml('a', 'busy', '<p>x</p>'), /停止/)
    await pageRepo.create(page('group', { spec: { id: 'group', name: 'group', groupOnly: true } }))
    await assert.rejects(versionRepo.initializeHtml('a', 'group', '<p>x</p>'), /导航分组/)
    await pageRepo.create(page('history'))
    await versionRepo.add('history', '<p>old</p>', 'generate')
    await pageRepo.update('history', { currentVersionId: undefined })
    await assert.rejects(versionRepo.initializeHtml('a', 'history', '<p>x</p>'), /已有内容/)
})
