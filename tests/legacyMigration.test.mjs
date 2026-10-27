import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createJiti } from 'jiti'
import { fileURLToPath } from 'node:url'

const stores = {
  projects: { keyPath: 'id' }, pages: { keyPath: 'id' }, pageVersions: { keyPath: 'id' },
  sourceDocs: { keyPath: 'id' }, assets: { keyPath: 'id' },
}

function openLegacy() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('quickpage', 2)
    request.onupgradeneeded = () => {
      for (const [name, options] of Object.entries(stores)) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, options)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function completed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve
    transaction.onerror = transaction.onabort = () => reject(transaction.error)
  })
}

test('legacy browser storage inspection and migration keep old data intact', async () => {
  const database = await openLegacy()
  const transaction = database.transaction(Object.keys(stores), 'readwrite')
  transaction.objectStore('projects').put({ id: 'legacy-project', name: '旧项目', platform: 'pc', createdAt: 1, updatedAt: 2 })
  transaction.objectStore('pages').put({ id: 'legacy-page', projectId: 'legacy-project', spec: { id: 'spec', name: '旧页面', description: '', blocks: [] }, sortOrder: 0, genStatus: 'done', currentVersionId: 'legacy-version', updatedAt: 2 })
  transaction.objectStore('pageVersions').put({ id: 'legacy-version', pageId: 'legacy-page', versionNumber: 1, html: '<p>旧内容</p>', source: 'generate', createdAt: 2 })
  transaction.objectStore('sourceDocs').put({ id: 'legacy-doc', projectId: 'legacy-project', fileName: '需求.txt', fileType: 'txt', text: '需求', meta: {} })
  transaction.objectStore('assets').put({ id: 'legacy-asset', projectId: 'legacy-project', docId: 'legacy-doc', mimeType: 'image/png', origin: 'upload', blob: new Blob(['image']) })
  await completed(transaction)
  database.close()
  const calls = []
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body)
    return new Response(JSON.stringify({ ok: true, result: { status: 'imported' } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const jiti = createJiti(import.meta.url, { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } })
  const { inspectLegacyStorage, migrateLegacyStorage } = await jiti.import('../src/services/storage/legacyMigration.ts')
  assert.deepEqual(await inspectLegacyStorage(), { available: true, projects: 1, pages: 1, versions: 1, docs: 1, assets: 1 })
  const result = await migrateLegacyStorage()
  assert.equal(result.importedProjects, 1)
  assert.equal(calls[0].action, 'legacy.importProject')
  assert.equal(calls[0].input.project.familyId, 'legacy-project')
  assert.equal(calls[0].input.project.iteration, 'v1.0')
  assert.equal(calls[0].input.versions[0].html, '<p>旧内容</p>')
  assert.equal(Buffer.from(calls[0].input.assets[0].blobBase64, 'base64').toString(), 'image')
  assert.equal((await inspectLegacyStorage()).projects, 1)
})
