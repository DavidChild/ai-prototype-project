import { nanoid } from 'nanoid'
import { storageRequest, type SourceDoc, type StoredAsset } from './db'
import type { Project, ProjectEndpointProfile } from '@/types/project'
import type { Page, PageVersion, PageVersionSource } from '@/types/page'
import type { GenerationConstraint } from '@/types/generationConstraint'
import { validateConstraint } from '@/prompts/generationConstraints'
import { validateStore, type AnnotationStore } from 'web-remarq/core'
import type { CopyIterationRequirementInput } from '@/types/iteration'
import type { IterationTask } from '@/types/iterationTask'

function clone<T>(value: T): T {
  // Vue reactive objects are JSON payloads, but cannot be structuredClone'd.
  return JSON.parse(JSON.stringify(value)) as T
}

function patchPayload<T extends object>(patch: T) {
  return { patch: clone(patch), unset: Object.keys(patch).filter((key) => patch[key as keyof T] === undefined) }
}

export const projectRepo = {
  list: () => storageRequest<Project[]>('project.list'),
  listSummaries: () => storageRequest<Array<Project & { pageCount: number }>>('project.listSummaries'),
  pageCounts: () => storageRequest<Array<{ projectId: string; count: number }>>('project.pageCounts'),
  get: (id: string) => storageRequest<Project | undefined>('project.get', { id }),
  async create(project: Project): Promise<void> {
    await storageRequest('project.create', { project: clone(project) })
  },
  async copyIteration(
    sourceId: string,
    iteration: string,
    requirement?: CopyIterationRequirementInput,
  ): Promise<Project> {
    const label = iteration.trim()
    if (!label) throw new Error('请输入版本号')
    return storageRequest<Project>('project.copyIteration', {
      sourceId,
      iteration: label,
      requirement: requirement ? clone(requirement) : undefined,
    })
  },
  async copyIterations(
    requests: Array<{
      sourceId: string
      iteration: string
      requirement: CopyIterationRequirementInput
    }>,
  ): Promise<Project[]> {
    if (!requests.length) throw new Error('请至少选择一个需要创建的新版本')
    return storageRequest<Project[]>('project.copyIterations', { requests: clone(requests) })
  },
  updateFamily: (familyId: string, patch: { name?: string; hidden?: boolean }) => storageRequest<void>('project.updateFamily', { familyId, patch }),
  updateProfile: (projectId: string, profile: ProjectEndpointProfile) =>
    storageRequest<ProjectEndpointProfile>('project.updateProfile', { projectId, profile: clone(profile) }),
  applyIterationPlan: (projectId: string, sourceProjectId: string, requirement: CopyIterationRequirementInput) =>
    storageRequest<Project>('project.applyIterationPlan', { projectId, sourceProjectId, requirement: clone(requirement) }),
  removeFamily: (familyId: string) => storageRequest<void>('project.removeFamily', { familyId }),
  update: (id: string, patch: Partial<Omit<Project, 'id'>>) => storageRequest<void>('project.update', { id, ...patchPayload(patch) }),
  async saveConstraint(projectId: string, item: GenerationConstraint): Promise<GenerationConstraint[]> {
    validateConstraint(item)
    return storageRequest('project.saveConstraint', { projectId, item: clone(item) })
  },
  removeConstraint: (projectId: string, id: string) => storageRequest<GenerationConstraint[]>('project.removeConstraint', { projectId, id }),
  setHidden: (id: string, hidden: boolean) => storageRequest<void>('project.setHidden', { id, hidden }),
  removeCascade: (id: string) => storageRequest<void>('project.removeCascade', { id }),
}

export const iterationTaskRepo = {
  list: () => storageRequest<IterationTask[]>('iterationTask.list'),
  listSummaries: () => storageRequest<IterationTask[]>('iterationTask.listSummaries'),
  create: (task: IterationTask) =>
    storageRequest<IterationTask>('iterationTask.create', { task: clone(task) }),
  save: (task: IterationTask) =>
    storageRequest<IterationTask>('iterationTask.save', { task: clone(task) }),
  cancel: (id: string, deleteVersions: boolean) =>
    storageRequest<IterationTask>('iterationTask.cancel', { id, deleteVersions }),
  remove: (id: string) => storageRequest<void>('iterationTask.remove', { id }),
}

export const pageRepo = {
  async copy(projectId: string, pageId: string, name: string): Promise<{ page: Page; pages: Page[]; version?: PageVersion; updatedAt: number }> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('页面名不能为空')
    return storageRequest('page.copy', { projectId, pageId, name: trimmed })
  },
  async rename(id: string, name: string): Promise<void> {
    const trimmed = name.trim(); if (!trimmed) throw new Error('页面名不能为空')
    await storageRequest('page.rename', { id, name: trimmed })
  },
  listByProject: (projectId: string) => storageRequest<Page[]>('page.listByProject', { projectId }),
  get: (id: string) => storageRequest<Page | undefined>('page.get', { id }),
  bulkCreate: (pages: Page[]) => storageRequest<void>('page.bulkCreate', { pages: clone(pages) }),
  create: (page: Page) => storageRequest<void>('page.create', { page: clone(page) }),
  saveHierarchy: (projectId: string, pages: Page[]) => storageRequest<void>('page.saveHierarchy', { projectId, pages: clone(pages) }),
  update: (id: string, patch: Partial<Omit<Page, 'id'>>) => storageRequest<void>('page.update', { id, ...patchPayload(patch) }),
  async saveAnnotationStore(id: string, input: AnnotationStore): Promise<AnnotationStore> {
    const result = validateStore(input)
    if (!result.ok) throw new Error(`标注数据无效：${result.errors[0] ?? '格式错误'}`)
    return storageRequest('page.saveAnnotationStore', { id, store: clone(result.store) })
  },
  remove: (id: string) => storageRequest<void>('page.remove', { id }),
  resetStale: (projectId: string) => storageRequest<void>('page.resetStale', { projectId }),
}

export const versionRepo = {
  async initializeHtml(projectId: string, pageId: string, html: string): Promise<PageVersion> {
    if (!html.trim()) throw new Error('HTML 内容不能为空')
    if (new TextEncoder().encode(html).length > 5 * 1024 * 1024) throw new Error('HTML 文件不能超过 5 MB')
    return storageRequest('version.initializeHtml', { projectId, pageId, html, source: 'import', feedbackText: '手动导入 HTML 初始化页面', versionId: nanoid() })
  },
  async importLayrr(projectId: string, pageId: string, baseline: string, html: string, feedbackText: string, submissionId?: string, source: 'layrr' | 'ai-local' = 'layrr'): Promise<PageVersion> {
    const note = feedbackText?.trim(); if (!note || note.length > 500) throw new Error('请输入 1–500 字的版本修改备注')
    return storageRequest('version.importLayrr', { projectId, pageId, baseline, html, feedbackText: note, source, versionId: submissionId ? 'layrr-' + submissionId : nanoid() })
  },
  listByPage: (pageId: string) => storageRequest<PageVersion[]>('version.listByPage', { pageId }),
  get: (id: string) => storageRequest<PageVersion | undefined>('version.get', { id }),
  add: (pageId: string, html: string, source: PageVersionSource, feedbackText?: string, versionId?: string) => storageRequest<PageVersion>('version.add', { pageId, html, source, feedbackText, versionId: versionId ?? nanoid() }),
}

async function assetPayload(asset: StoredAsset) {
  const bytes = new Uint8Array(await asset.blob.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return { ...asset, blob: undefined, blobBase64: btoa(binary) }
}

export async function createProjectBundle(
  project: Project,
  pages: Page[],
  docs: SourceDoc[],
  assets: StoredAsset[],
): Promise<void> {
  await storageRequest('project.createBundle', {
    project: clone(project),
    pages: clone(pages),
    docs: clone(docs),
    assets: await Promise.all(assets.map(assetPayload)),
  })
}

export async function saveImportedProjectBundle(
  project: Project,
  pages: Page[],
  versions: PageVersion[],
  docs: SourceDoc[],
  assets: StoredAsset[],
  targetProjectId?: string,
): Promise<string> {
  const result = await storageRequest<{ projectId: string }>('project.importBundle', {
    targetProjectId,
    project: clone(project),
    pages: clone(pages),
    versions: clone(versions),
    docs: clone(docs),
    assets: await Promise.all(assets.map(assetPayload)),
  })
  return result.projectId
}

export const docRepo = {
  bulkCreate: (docs: SourceDoc[]) => storageRequest<void>('doc.bulkCreate', { docs: clone(docs) }),
  listByProject: (projectId: string) => storageRequest<SourceDoc[]>('doc.listByProject', { projectId }),
}

export const assetRepo = {
  async bulkCreate(assets: StoredAsset[]): Promise<void> {
    await storageRequest('asset.bulkCreate', { assets: await Promise.all(assets.map(assetPayload)) })
  },
  async listByProject(projectId: string): Promise<StoredAsset[]> {
    const assets = await storageRequest<(Omit<StoredAsset, 'blob'> & { blobBase64: string })[]>('asset.listByProject', { projectId })
    return assets.map(({ blobBase64, ...asset }) => {
      const binary = atob(blobBase64), bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
      return { ...asset, blob: new Blob([bytes], { type: asset.mimeType }) }
    })
  },
}

export async function loadWorkbench(projectId: string): Promise<{ project: Project; pages: Page[]; htmlByPage: Map<string, string> } | null> {
  const result = await storageRequest<{ project: Project; pages: Page[]; htmlByPage: Record<string, string> } | null>('workbench.load', { projectId })
  return result ? { ...result, htmlByPage: new Map(Object.entries(result.htmlByPage)) } : null
}

export function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  return storageRequest('usage')
}
