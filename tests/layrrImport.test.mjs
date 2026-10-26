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
      versionRepo.importLayrr('iteration-b', 'page', base.id, '<p>wrong</p>', '调整文字'),
      /不属于/,
    )
    for (const note of ['', '   ', 'a'.repeat(501)]) {
      await assert.rejects(
        versionRepo.importLayrr('iteration-a', 'page', base.id, '<p>edited</p>', note),
        /版本修改备注/,
      )
    }
    const edited = await versionRepo.importLayrr('iteration-a', 'page', base.id, '<p>edited</p>', '  调整文字  ', 'first-submission')
    assert.equal(edited.source, 'layrr')
    assert.equal(edited.pageId, 'page')
    assert.equal(edited.feedbackText, '调整文字')
    assert.equal(edited.versionNumber, base.versionNumber + 1)
    const retried = await versionRepo.importLayrr('iteration-a', 'page', base.id, '<p>edited</p>', '调整文字', 'first-submission')
    assert.equal(retried.id, edited.id)
    await assert.rejects(
      versionRepo.importLayrr('iteration-b', 'page', base.id, '<p>edited</p>', '调整文字', 'first-submission'),
      /不属于/,
    )
    await assert.rejects(
      versionRepo.importLayrr('iteration-a', 'page', base.id, '<p>different</p>', '调整文字', 'first-submission'),
      /不一致/,
    )
    await assert.rejects(
      versionRepo.importLayrr('iteration-a', 'page', base.id, '<p>stale</p>', '再次调整'),
      /新版本/,
    )
    assert.equal((await pageRepo.get('page')).currentVersionId, edited.id)
    await pageRepo.update('page', { genStatus: 'generating' })
    await assert.rejects(
      versionRepo.importLayrr('iteration-a', 'page', edited.id, '<p>busy</p>', '再次调整'),
      /仍在生成/,
    )
    assert.equal((await versionRepo.listByPage('page')).length, 2)
    await pageRepo.update('page', { genStatus: 'done' })
    const next = await versionRepo.importLayrr('iteration-a', 'page', edited.id, '<p>continued</p>', '继续调整间距', 'next-submission')
    assert.equal(next.versionNumber, edited.versionNumber + 1)
    assert.equal(next.feedbackText, '继续调整间距')
    assert.equal((await pageRepo.get('page')).currentVersionId, next.id)
    const ai = await versionRepo.importLayrr('iteration-a', 'page', next.id, '<p>AI edited</p>', '调整标题', 'ai-submission', 'ai-local')
    assert.equal(ai.source, 'ai-local')
    assert.equal(ai.versionNumber, next.versionNumber + 1)
    assert.equal((await versionRepo.importLayrr('iteration-a', 'page', next.id, ai.html, '调整标题', 'ai-submission', 'ai-local')).id, ai.id)
    await assert.rejects(
      versionRepo.importLayrr('iteration-a', 'page', next.id, ai.html, '调整标题', 'ai-submission', 'layrr'),
      /不一致/,
    )
  } finally {
    await db.delete()
  }
})
