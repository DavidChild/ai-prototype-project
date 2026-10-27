import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive } from 'vue'
import { startStorageTest } from './storageTestHarness.mjs'

test('MySQL storage schema, migration, atomic writes and concurrency', async (t) => {
  const { projectRepo, pageRepo, versionRepo, createProjectBundle, saveImportedProjectBundle, storageRequest, connection, counts, base, fetch, client: createClient } = await startStorageTest(t)
  const project = (id) => ({ id, name: id, createdAt: 1, updatedAt: 1 })
  const page = (id, projectId) => ({ id, projectId, spec: { id, name: id, blocks: [], description: '' }, sortOrder: 0, genStatus: 'idle', updatedAt: 1 })
  await t.test('storage and SaaS InnoDB tables and cascade foreign keys exist', async () => {
    const [tables] = await connection.query('SELECT table_name, engine, table_collation FROM information_schema.tables WHERE table_schema = DATABASE()')
    assert.equal(tables.length, 20)
    assert.ok(tables.every((row) => row.engine === 'InnoDB' && row.table_collation.startsWith('utf8mb4')))
    const [fks] = await connection.query('SELECT delete_rule FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE()')
    assert.ok(fks.length >= 12)
    assert.ok(fks.every((row) => row.delete_rule === 'CASCADE'))
  })
  await t.test('project bundle failure rolls back every table', async () => {
    const before = await counts()
    await assert.rejects(createProjectBundle(project('failed'), [page('failed-page', 'failed')], [], [
      { id: 'bad-asset', projectId: 'failed', docId: 'doc', mimeType: 'image/png', blob: new Blob(['image']) },
    ]))
    assert.deepEqual(await counts(), before)
  })
  await t.test('legacy project import preserves IDs and rolls back incomplete projects', async () => {
    const imported = await storageRequest('legacy.importProject', {
      project: project('legacy'),
      pages: [page('legacy-page', 'legacy')],
      versions: [{ id: 'legacy-version', pageId: 'legacy-page', versionNumber: 1, html: '<p>legacy</p>', source: 'generate', createdAt: 1 }],
      docs: [{ id: 'legacy-doc', projectId: 'legacy', fileName: 'legacy.txt', fileType: 'txt', text: 'legacy', meta: {} }],
      assets: [{ id: 'legacy-asset', projectId: 'legacy', docId: 'legacy-doc', mimeType: 'text/plain', origin: 'upload', blobBase64: Buffer.from('legacy').toString('base64') }],
    })
    assert.equal(imported.status, 'imported')
    assert.equal((await versionRepo.get('legacy-version')).html, '<p>legacy</p>')
    assert.equal((await storageRequest('legacy.importProject', { project: project('legacy') })).status, 'skipped')
    const before = await counts()
    await assert.rejects(storageRequest('legacy.importProject', {
      project: project('broken'),
      pages: [page('broken-page', 'broken')],
      versions: [{ id: 'orphan-version', pageId: 'missing-page', versionNumber: 1, html: '', source: 'generate', createdAt: 1 }],
      docs: [], assets: [],
    }), /无法归属/)
    assert.deepEqual(await counts(), before)
    await projectRepo.removeCascade('legacy')
  })
  await t.test('project package import creates projects and can initialize an existing empty project', async () => {
    const importedPage = { ...page('package-page', 'package-project'), currentVersionId: 'package-version', genStatus: 'done' }
    const importedId = await saveImportedProjectBundle(
      project('package-project'),
      [importedPage],
      [{ id: 'package-version', pageId: 'package-page', versionNumber: 1, html: '<p>package</p>', source: 'import', createdAt: 2 }],
      [{ id: 'package-doc', projectId: 'package-project', fileName: 'source.txt', fileType: 'txt', text: 'source', meta: {} }],
      [{ id: 'package-asset', projectId: 'package-project', docId: 'package-doc', mimeType: 'text/plain', origin: 'upload', blob: new Blob(['asset']) }],
    )
    assert.equal(importedId, 'package-project')
    assert.equal((await versionRepo.get('package-version')).html, '<p>package</p>')

    await projectRepo.create(project('empty-target'))
    const targetPage = { ...page('target-page', 'empty-target'), currentVersionId: 'target-version', genStatus: 'done' }
    const targetId = await saveImportedProjectBundle(
      project('empty-target'),
      [targetPage],
      [{ id: 'target-version', pageId: 'target-page', versionNumber: 1, html: '<p>target</p>', source: 'import', createdAt: 3 }],
      [],
      [],
      'empty-target',
    )
    assert.equal(targetId, 'empty-target')
    assert.equal((await pageRepo.listByProject('empty-target')).length, 1)
    assert.equal((await versionRepo.get('target-version')).html, '<p>target</p>')
    await projectRepo.removeCascade('package-project')
    await projectRepo.removeCascade('empty-target')
  })
  await createProjectBundle(reactive(project('test')), [page('main', 'test')], [], [])
  await t.test('undefined patch fields are actually removed and parallel patches do not overwrite', async () => {
    await pageRepo.update('main', { errorMessage: 'old failure' })
    await Promise.all([pageRepo.update('main', { errorMessage: undefined }), pageRepo.update('main', { reviewPending: true })])
    const saved = await pageRepo.get('main')
    assert.equal(saved.errorMessage, undefined)
    assert.equal(saved.reviewPending, true)
    await projectRepo.update('test', reactive({ hidden: true }))
    assert.equal((await projectRepo.get('test')).hidden, true)
  })
  await t.test('concurrent versions have unique increasing numbers and history is trimmed to 20', async () => {
    const versions = await Promise.all(Array.from({ length: 24 }, (_, index) => versionRepo.add('main', `<p>${index}</p>`, 'refine')))
    assert.deepEqual(versions.map((version) => version.versionNumber).sort((a, b) => a - b), Array.from({ length: 24 }, (_, index) => index + 1))
    const history = await versionRepo.listByPage('main')
    assert.equal(history.length, 20)
    assert.equal(history[0].versionNumber, 24)
    assert.equal(history.at(-1).versionNumber, 5)
    assert.equal((await pageRepo.get('main')).currentVersionId, history[0].id)
  })
  await t.test('page copy preserves HTML, hierarchy and sort order independently', async () => {
    const copied = await pageRepo.copy('test', 'main', 'main copy')
    assert.equal(copied.page.spec.name, 'main copy')
    assert.equal(copied.page.currentVersionId, copied.version.id)
    assert.equal(copied.version.html, (await versionRepo.listByPage('main'))[0].html)
    assert.deepEqual(copied.pages.map((page) => page.sortOrder), [0, 1])
    assert.deepEqual(await pageRepo.get(copied.page.id), copied.page)
    assert.equal(copied.version.versionNumber, 1)
  })
  await t.test('simultaneous duplicate submissions are idempotent', async () => {
    const baseline = (await pageRepo.get('main')).currentVersionId
    const results = await Promise.all(Array.from({ length: 3 }, () => versionRepo.importLayrr('test', 'main', baseline, '<p>same submission</p>', '修改说明', 'concurrent')))
    assert.ok(results.every((version) => version.id === results[0].id && version.versionNumber === results[0].versionNumber))
  })
  await t.test('short share links enforce access and resolve live page updates', async () => {
    await assert.rejects(storageRequest('share.create', {
      projectId: 'test', access: 'public', scope: 'single', pageIds: ['main'], includeAnnotations: false,
    }), /公开分享必须设置有效期/)
    const publicShare = await storageRequest('share.create', {
      projectId: 'test', access: 'public', scope: 'single', pageIds: ['main'], includeAnnotations: false,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    })
    assert.match(publicShare.code, /^[A-Za-z0-9_-]{10}$/)
    const anonymous = createClient()
    const first = await anonymous('share.resolve', { code: publicShare.code })
    assert.equal(first.status, 200)
    const originalHtml = first.payload.result.iterations[0].pages.find((item) => item.id === 'main').html
    await versionRepo.add('main', '<main>live share update</main>', 'refine')
    const updated = await anonymous('share.resolve', { code: publicShare.code, trackView: false })
    assert.equal(updated.payload.result.iterations[0].pages.find((item) => item.id === 'main').html, '<main>live share update</main>')
    assert.notEqual(originalHtml, '<main>live share update</main>')

    const currentMain = await pageRepo.get('main')
    await pageRepo.update('main', { spec: { ...currentMain.spec, name: 'main v1.0' } })
    await pageRepo.create({ ...page('old-version', 'test'), spec: { ...page('old-version', 'test').spec, name: 'old page v0.9' } })
    await versionRepo.initializeHtml('test', 'old-version', '<main>old version</main>')
    const iterationShare = await storageRequest('share.create', {
      projectId: 'test', access: 'public', scope: 'iteration', includeAnnotations: false,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    })
    const iterationPageIds = (await pageRepo.listByProject('test')).filter((item) => !item.spec.groupOnly && item.currentVersionId).map((item) => item.id)
    const iterationResult = await anonymous('share.resolve', { code: iterationShare.code })
    assert.deepEqual(
      iterationResult.payload.result.iterations[0].pages.filter((item) => item.html).map((item) => item.id),
      iterationPageIds,
    )
    await pageRepo.create({ ...page('later-page', 'test'), spec: { ...page('later-page', 'test').spec, name: '后续新增页面' }, sortOrder: 2 })
    await versionRepo.initializeHtml('test', 'later-page', '<main>later page</main>')
    const copiedIteration = await projectRepo.copyIteration('test', 'v2.0')
    const refreshedIterationResult = await anonymous('share.resolve', { code: iterationShare.code, trackView: false })
    assert.equal(refreshedIterationResult.payload.result.iterations.length, 1)
    assert.equal(refreshedIterationResult.payload.result.iterations[0].project.id, 'test')
    assert.deepEqual(
      refreshedIterationResult.payload.result.iterations[0].pages.filter((item) => item.html).map((item) => item.id),
      [...iterationPageIds, 'later-page'],
    )
    await projectRepo.removeCascade(copiedIteration.id)

    const tenantShare = await storageRequest('share.create', {
      projectId: 'test', access: 'tenant', scope: 'iteration', includeAnnotations: true,
    })
    const samePermanentShare = await storageRequest('share.create', {
      projectId: 'test', access: 'tenant', scope: 'iteration', includeAnnotations: true,
    })
    assert.equal(samePermanentShare.code, tenantShare.code)
    const denied = await anonymous('share.resolve', { code: tenantShare.code })
    assert.equal(denied.status, 401)
    await storageRequest('share.revoke', { projectId: 'test', id: publicShare.id })
    const revoked = await anonymous('share.resolve', { code: publicShare.code })
    assert.equal(revoked.status, 410)
  })
  await t.test('storage rejects GET and cross-origin mutation requests', async () => {
    assert.equal((await fetch(base + '/api/storage')).status, 405)
    const cross = await fetch(base + '/api/storage', { method: 'POST', headers: { origin: 'https://untrusted.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'clearAll' }) })
    assert.equal(cross.status, 403)
    assert.ok(await projectRepo.get('test'))
  })
  await projectRepo.removeCascade('test')
  assert.deepEqual(await counts(), { projects: 0, pages: 0, page_versions: 0, source_docs: 0, assets: 0 })
})
