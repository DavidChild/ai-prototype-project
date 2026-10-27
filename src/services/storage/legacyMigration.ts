import type { Project } from '@/types/project'
import type { Page, PageVersion } from '@/types/page'
import type { SourceDoc, StoredAsset } from './db'
import { storageRequest } from './db'

const LEGACY_DB_NAME = 'quickpage'
const STORES = ['projects', 'pages', 'pageVersions', 'sourceDocs', 'assets'] as const

export interface LegacyStorageSummary {
  available: boolean
  projects: number
  pages: number
  versions: number
  docs: number
  assets: number
}

export interface LegacyMigrationResult {
  importedProjects: number
  skippedProjects: number
  failedProjects: { id: string; name: string; error: string }[]
  pages: number
  versions: number
  docs: number
  assets: number
}

interface LegacySnapshot {
  projects: Project[]
  pages: Page[]
  versions: PageVersion[]
  docs: SourceDoc[]
  assets: StoredAsset[]
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('读取浏览器旧数据失败'))
  })
}

async function openLegacyDatabase(): Promise<IDBDatabase | null> {
  if (!globalThis.indexedDB) return null
  if (indexedDB.databases) {
    const databases = await indexedDB.databases()
    if (!databases.some((item) => item.name === LEGACY_DB_NAME)) return null
  }
  return new Promise((resolve, reject) => {
    let created = false
    const request = indexedDB.open(LEGACY_DB_NAME)
    request.onupgradeneeded = (event) => {
      created = event.oldVersion === 0
      if (created) request.transaction?.abort()
    }
    request.onsuccess = () => {
      const database = request.result
      if (created || !STORES.every((name) => database.objectStoreNames.contains(name))) {
        database.close()
        resolve(null)
      } else resolve(database)
    }
    request.onerror = () => {
      if (created && request.error?.name === 'AbortError') {
        const cleanup = indexedDB.deleteDatabase(LEGACY_DB_NAME)
        cleanup.onsuccess = cleanup.onerror = cleanup.onblocked = () => resolve(null)
      } else reject(request.error ?? new Error('无法打开浏览器旧数据库'))
    }
    request.onblocked = () => reject(new Error('旧数据库正被其他页面占用，请关闭其他快页标签后重试'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('读取浏览器旧数据失败'))
  })
}

async function readSnapshot(): Promise<LegacySnapshot | null> {
  const database = await openLegacyDatabase()
  if (!database) return null
  try {
    const transaction = database.transaction([...STORES], 'readonly')
    const [projects, pages, versions, docs, assets] = await Promise.all([
      requestResult(transaction.objectStore('projects').getAll()) as Promise<Project[]>,
      requestResult(transaction.objectStore('pages').getAll()) as Promise<Page[]>,
      requestResult(transaction.objectStore('pageVersions').getAll()) as Promise<PageVersion[]>,
      requestResult(transaction.objectStore('sourceDocs').getAll()) as Promise<SourceDoc[]>,
      requestResult(transaction.objectStore('assets').getAll()) as Promise<StoredAsset[]>,
      transactionDone(transaction),
    ])
    return { projects, pages, versions, docs, assets }
  } finally {
    database.close()
  }
}

export async function inspectLegacyStorage(): Promise<LegacyStorageSummary> {
  const snapshot = await readSnapshot()
  return snapshot
    ? { available: snapshot.projects.length > 0, projects: snapshot.projects.length, pages: snapshot.pages.length, versions: snapshot.versions.length, docs: snapshot.docs.length, assets: snapshot.assets.length }
    : { available: false, projects: 0, pages: 0, versions: 0, docs: 0, assets: 0 }
}

async function assetPayload(asset: StoredAsset) {
  const bytes = new Uint8Array(await asset.blob.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return { ...asset, blob: undefined, blobBase64: btoa(binary) }
}

export async function migrateLegacyStorage(onProgress?: (done: number, total: number, project: Project) => void): Promise<LegacyMigrationResult> {
  const snapshot = await readSnapshot()
  if (!snapshot?.projects.length) throw new Error('没有检测到可迁移的浏览器旧项目')
  const result: LegacyMigrationResult = { importedProjects: 0, skippedProjects: 0, failedProjects: [], pages: 0, versions: 0, docs: 0, assets: 0 }
  for (let index = 0; index < snapshot.projects.length; index++) {
    const project = snapshot.projects[index]!
    onProgress?.(index, snapshot.projects.length, project)
    const pages = snapshot.pages.filter((item) => item.projectId === project.id)
    const pageIds = new Set(pages.map((item) => item.id))
    const versions = snapshot.versions.filter((item) => pageIds.has(item.pageId))
    const docs = snapshot.docs.filter((item) => item.projectId === project.id)
    const assets = snapshot.assets.filter((item) => item.projectId === project.id)
    try {
      const response = await storageRequest<{ status: 'imported' | 'skipped' }>('legacy.importProject', {
        project: { ...project, familyId: project.familyId ?? project.id, iteration: project.iteration ?? 'v1.0' },
        pages, versions, docs, assets: await Promise.all(assets.map(assetPayload)),
      })
      if (response.status === 'skipped') result.skippedProjects++
      else {
        result.importedProjects++
        result.pages += pages.length
        result.versions += versions.length
        result.docs += docs.length
        result.assets += assets.length
      }
    } catch (error) {
      result.failedProjects.push({ id: project.id, name: project.name || project.id, error: error instanceof Error ? error.message : '迁移失败' })
    }
    onProgress?.(index + 1, snapshot.projects.length, project)
  }
  return result
}
