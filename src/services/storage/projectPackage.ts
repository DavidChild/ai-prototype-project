import { nanoid } from 'nanoid'
import type { Project } from '@/types/project'
import type { Page, PageVersion } from '@/types/page'
import type { SourceDoc, StoredAsset } from './db'
import {
  assetRepo,
  docRepo,
  pageRepo,
  projectRepo,
  saveImportedProjectBundle,
  versionRepo,
} from './repositories'

const FORMAT = 'xiaodou-prototype-project'
const SCHEMA_VERSION = 1
const MAGIC = new TextEncoder().encode('XDPROTO1G')
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024

interface PackedAsset extends Omit<StoredAsset, 'blob'> {
  blobBase64: string
}

interface ProjectPackagePayload {
  format: typeof FORMAT
  schemaVersion: typeof SCHEMA_VERSION
  exportedAt: number
  project: Project
  pages: Page[]
  versions: PageVersion[]
  docs: SourceDoc[]
  assets: PackedAsset[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function base64ToBlob(value: string, mimeType: string): Blob {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new Blob([Uint8Array.from(bytes).buffer], { type: mimeType })
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') throw new Error('当前浏览器不支持项目包压缩')
  const stream = new Blob([Uint8Array.from(bytes).buffer]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持项目包解压')
  const stream = new Blob([Uint8Array.from(bytes).buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

function hasMagic(bytes: Uint8Array): boolean {
  return MAGIC.every((value, index) => bytes[index] === value)
}

function validatePayload(value: unknown): ProjectPackagePayload {
  if (!value || typeof value !== 'object') throw new Error('项目包内容无效')
  const payload = value as Partial<ProjectPackagePayload>
  if (payload.format !== FORMAT) throw new Error('不是小豆原型项目包')
  if (payload.schemaVersion !== SCHEMA_VERSION) throw new Error('项目包版本不受支持，请升级系统后重试')
  if (!payload.project?.id || !Array.isArray(payload.pages) || !Array.isArray(payload.versions) || !Array.isArray(payload.docs) || !Array.isArray(payload.assets))
    throw new Error('项目包数据不完整')
  return payload as ProjectPackagePayload
}

export async function buildProjectPackage(projectId: string): Promise<Blob> {
  const project = await projectRepo.get(projectId)
  if (!project) throw new Error('项目不存在或已被删除')
  const [pages, docs, assets] = await Promise.all([
    pageRepo.listByProject(projectId),
    docRepo.listByProject(projectId),
    assetRepo.listByProject(projectId),
  ])
  const versions = (await Promise.all(pages.map((page) => versionRepo.listByPage(page.id)))).flat()
  const payload: ProjectPackagePayload = {
    format: FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    project: clone(project),
    pages: clone(pages),
    versions: clone(versions),
    docs: clone(docs),
    assets: await Promise.all(assets.map(async ({ blob, ...asset }) => ({
      ...clone(asset),
      blobBase64: await blobToBase64(blob),
    }))),
  }
  const compressed = await gzip(new TextEncoder().encode(JSON.stringify(payload)))
  return new Blob(
    [Uint8Array.from(MAGIC).buffer, Uint8Array.from(compressed).buffer],
    { type: 'application/x-xiaodou-prototype' },
  )
}

export async function readProjectPackage(file: File): Promise<ProjectPackagePayload> {
  if (file.size > MAX_PACKAGE_BYTES) throw new Error('项目包不能超过 256 MB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length <= MAGIC.length || !hasMagic(bytes)) throw new Error('项目包格式不正确，请选择 .xdproto 文件')
  try {
    return validatePayload(JSON.parse(await gunzip(bytes.subarray(MAGIC.length))))
  } catch (error) {
    if (error instanceof Error && /项目包|不支持/.test(error.message)) throw error
    throw new Error('项目包已损坏或内容无法解析')
  }
}

function remapPayload(payload: ProjectPackagePayload, targetProjectId?: string) {
  const now = Date.now()
  const projectId = targetProjectId || nanoid()
  const pageIdMap = new Map(payload.pages.map((page) => [page.id, nanoid()]))
  const specIdMap = new Map(payload.pages.map((page) => [page.spec.id, nanoid()]))
  const versionIdMap = new Map(payload.versions.map((version) => [version.id, nanoid()]))
  const docIdMap = new Map(payload.docs.map((doc) => [doc.id, nanoid()]))

  const pages: Page[] = payload.pages.map((page) => {
    const importedPages = page.spec.importedPages?.flatMap((reference) => {
      const pageId = pageIdMap.get(reference.pageId)
      return pageId ? [{ ...reference, pageId }] : []
    })
    const currentVersionId = page.currentVersionId
      ? versionIdMap.get(page.currentVersionId)
      : undefined
    return {
      ...clone(page),
      id: pageIdMap.get(page.id)!,
      projectId,
      spec: {
        ...clone(page.spec),
        id: specIdMap.get(page.spec.id)!,
        parentId: page.spec.parentId ? specIdMap.get(page.spec.parentId) : undefined,
        importedPages,
      },
      currentVersionId,
      genStatus: currentVersionId ? 'done' : 'idle',
      updatedAt: now,
    }
  })
  const versions: PageVersion[] = payload.versions.flatMap((version) => {
    const pageId = pageIdMap.get(version.pageId)
    return pageId ? [{
      ...clone(version),
      id: versionIdMap.get(version.id)!,
      pageId,
    }] : []
  })
  const docs: SourceDoc[] = payload.docs.map((doc) => ({
    ...clone(doc),
    id: docIdMap.get(doc.id)!,
    projectId,
  }))
  const assets: StoredAsset[] = payload.assets.flatMap((asset) => {
    const docId = docIdMap.get(asset.docId)
    return docId ? [{
      id: nanoid(),
      projectId,
      docId,
      mimeType: asset.mimeType,
      origin: clone(asset.origin),
      blob: base64ToBlob(asset.blobBase64, asset.mimeType),
    }] : []
  })
  const source = payload.project
  const project: Project = {
    ...clone(source),
    id: projectId,
    familyId: targetProjectId ? source.familyId : projectId,
    iteration: targetProjectId ? source.iteration : 'v1.0',
    basedOnId: undefined,
    hidden: false,
    analysis: source.analysis
      ? { ...clone(source.analysis), pages: pages.map((page) => clone(page.spec)) }
      : undefined,
    createdAt: targetProjectId ? source.createdAt : now,
    updatedAt: now,
  }
  return { project, pages, versions, docs, assets }
}

export async function importProjectPackage(file: File, targetProjectId?: string): Promise<string> {
  const payload = await readProjectPackage(file)
  const bundle = remapPayload(payload, targetProjectId)
  return saveImportedProjectBundle(
    bundle.project,
    bundle.pages,
    bundle.versions,
    bundle.docs,
    bundle.assets,
    targetProjectId,
  )
}
