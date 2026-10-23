import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createJiti } from 'jiti'
import { fileURLToPath } from 'node:url'
const jiti = createJiti(import.meta.url, {
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
})
const { db } = await jiti.import('../src/services/storage/db.ts')
const { pageRepo, versionRepo } = await jiti.import('../src/services/storage/repositories.ts')
test('Layrr import is bound to original iteration and baseline; conflicts never overwrite', async () => {
  try {
    await pageRepo.create({
      id: 'page',
      projectId: 'iteration-a',
      spec: { id: 'spec', name: 'page', blocks: [], description: '' },
      genStatus: 'idle',
      sortOrder: 0,
      updatedAt: 0,
    })
    const base = await versionRepo.add('page', '<p>base</p>', 'generate')
    await assert.rejects(
      versionRepo.importLayrr('iteration-b', 'page', base.id, '<p>wrong</p>'),
      /不属于/,
    )
    const edited = await versionRepo.importLayrr('iteration-a', 'page', base.id, '<p>edited</p>')
    assert.equal(edited.source, 'layrr')
    assert.equal(edited.pageId, 'page')
    await assert.rejects(
      versionRepo.importLayrr('iteration-a', 'page', base.id, '<p>stale</p>'),
      /新版本/,
    )
    assert.equal((await pageRepo.get('page')).currentVersionId, edited.id)
    await pageRepo.update('page', { genStatus: 'generating' })
    await assert.rejects(
      versionRepo.importLayrr('iteration-a', 'page', edited.id, '<p>busy</p>'),
      /仍在生成/,
    )
    assert.equal((await versionRepo.listByPage('page')).length, 2)
  } finally {
    await db.delete()
  }
})
