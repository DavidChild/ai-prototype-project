import test from 'node:test'
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
}
const jiti = createJiti(import.meta.url, {
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
})

test('iteration selection persists per project and handles malformed storage', async () => {
  const { useIterationSelectionStore } = await jiti.import('../src/stores/iterationSelection.ts')
  setActivePinia(createPinia())
  const first = useIterationSelectionStore()
  first.select('project-a', 'v2-id')
  first.select('project-b', 'v3-id')
  setActivePinia(createPinia())
  const restored = useIterationSelectionStore()
  assert.equal(restored.selected['project-a'], 'v2-id')
  assert.equal(restored.selected['project-b'], 'v3-id')
  storage.set('quickpage:selected-iterations', 'broken-json')
  setActivePinia(createPinia())
  assert.deepEqual(useIterationSelectionStore().selected, {})
})

test('late history queries cannot replace current history or rollback a different iteration', async () => {
  const { useWorkbenchStore } = await jiti.import('../src/stores/workbench.ts')
  const { versionRepo } = await jiti.import('@/services/storage/repositories')
  setActivePinia(createPinia())
  const wb = useWorkbenchStore()
  const originalList = versionRepo.listByPage
  const originalAdd = versionRepo.add
  const pending = new Map()
  versionRepo.listByPage = (id) => new Promise((resolve) => pending.set(id, resolve))
  let writes = 0
  versionRepo.add = async () => {
    writes++
    throw new Error('unexpected write')
  }
  try {
    wb.selectPage('old-page')
    wb.selectPage('new-page')
    pending.get('new-page')([{ id: 'new-history', pageId: 'new-page' }])
    await new Promise((resolve) => setImmediate(resolve))
    pending.get('old-page')([{ id: 'old-history', pageId: 'old-page' }])
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(wb.versions[0].id, 'new-history')
    await wb.rollbackTo({ id: 'old-history', pageId: 'old-page', html: 'old' })
    assert.equal(writes, 0)
  } finally {
    versionRepo.listByPage = originalList
    versionRepo.add = originalAdd
  }
})
