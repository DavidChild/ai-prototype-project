import { nanoid } from 'nanoid'
import { db, type SourceDoc, type StoredAsset } from './db'
import type { Project } from '@/types/project'
import type { Page, PageVersion, PageVersionSource } from '@/types/page'

const MAX_VERSIONS_PER_PAGE = 20

export const projectRepo = {
  list(): Promise<Project[]> {
    return db.projects.orderBy('updatedAt').reverse().toArray()
  },

  get(id: string): Promise<Project | undefined> {
    return db.projects.get(id)
  },

  async create(project: Project): Promise<void> {
    await db.projects.add({
      ...project,
      familyId: project.familyId ?? project.id,
      iteration: project.iteration ?? 'v1.0',
    })
  },

  async copyIteration(sourceId: string, iteration: string): Promise<Project> {
    const label = iteration.trim()
    if (!label) throw new Error('请输入版本号')
    return db.transaction(
      'rw',
      [db.projects, db.pages, db.pageVersions, db.sourceDocs, db.assets],
      async () => {
        const source = await db.projects.get(sourceId)
        if (!source) throw new Error('来源版本不存在')
        const familyId = source.familyId ?? source.id
        const siblings = await db.projects.where('familyId').equals(familyId).toArray()
        if (siblings.some((p) => p.iteration?.toLowerCase() === label.toLowerCase()))
          throw new Error('该版本号已存在')
        const now = Date.now()
        const target: Project = {
          ...source,
          id: nanoid(),
          familyId,
          iteration: label,
          basedOnId: source.id,
          createdAt: now,
          updatedAt: now,
        }
        const pages = await pageRepo.listByProject(sourceId)
        if (pages.some((p) => p.genStatus === 'queued' || p.genStatus === 'generating'))
          throw new Error('来源版本仍在生成，请先停止生成或等待完成')
        const pageIds = new Map(pages.map((p) => [p.id, nanoid()]))
        const versions = await db.pageVersions
          .where('pageId')
          .anyOf([...pageIds.keys()])
          .toArray()
        const versionIds = new Map(versions.map((v) => [v.id, nanoid()]))
        const docs = await db.sourceDocs.where('projectId').equals(sourceId).toArray()
        const docIds = new Map(docs.map((d) => [d.id, nanoid()]))
        const assets = await db.assets.where('projectId').equals(sourceId).toArray()
        await db.projects.add(target)
        await db.pages.bulkAdd(
          pages.map((p) => ({
            ...p,
            id: pageIds.get(p.id)!,
            projectId: target.id,
            currentVersionId: p.currentVersionId ? versionIds.get(p.currentVersionId) : undefined,
            updatedAt: now,
          })),
        )
        await db.pageVersions.bulkAdd(
          versions.map((v) => ({
            ...v,
            id: versionIds.get(v.id)!,
            pageId: pageIds.get(v.pageId)!,
          })),
        )
        await db.sourceDocs.bulkAdd(
          docs.map((d) => ({ ...d, id: docIds.get(d.id)!, projectId: target.id })),
        )
        await db.assets.bulkAdd(
          assets.map((a) => ({
            ...a,
            id: nanoid(),
            projectId: target.id,
            docId: docIds.get(a.docId) ?? a.docId,
          })),
        )
        return target
      },
    )
  },

  async updateFamily(familyId: string, patch: { name?: string; hidden?: boolean }): Promise<void> {
    await db.projects.where('familyId').equals(familyId).modify(patch)
  },

  async removeFamily(familyId: string): Promise<void> {
    await db.transaction(
      'rw',
      [db.projects, db.pages, db.pageVersions, db.sourceDocs, db.assets],
      async () => {
        const iterations = await db.projects.where('familyId').equals(familyId).primaryKeys()
        for (const id of iterations) await projectRepo.removeCascade(id)
      },
    )
  },

  async update(id: string, patch: Partial<Omit<Project, 'id'>>): Promise<void> {
    await db.projects.update(id, { ...patch, updatedAt: Date.now() })
  },

  /** 切换可见性不改变内容更新时间或项目排列顺序。 */
  async setHidden(id: string, hidden: boolean): Promise<void> {
    const updated = await db.projects.update(id, { hidden })
    if (!updated) throw new Error('项目不存在，请刷新后重试')
  },

  /** 级联删除项目及其页面、版本、源文档、图片资产 */
  async removeCascade(id: string): Promise<void> {
    await db.transaction(
      'rw',
      [db.projects, db.pages, db.pageVersions, db.sourceDocs, db.assets],
      async () => {
        const pageIds = (await db.pages.where('projectId').equals(id).primaryKeys()) as string[]
        await db.pageVersions.where('pageId').anyOf(pageIds).delete()
        await db.pages.where('projectId').equals(id).delete()
        await db.sourceDocs.where('projectId').equals(id).delete()
        await db.assets.where('projectId').equals(id).delete()
        await db.projects.delete(id)
      },
    )
  },
}

export const pageRepo = {
  /** 只更新名称，不覆盖层级、生成状态或版本引用。 */
  async rename(id: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('页面名不能为空')
    await db.transaction('rw', [db.pages, db.projects], async () => {
      const page = await db.pages.get(id)
      if (!page) throw new Error('页面不存在，请刷新后重试')
      const now = Date.now()
      await db.pages.update(id, { 'spec.name': trimmed, updatedAt: now })
      const project = await db.projects.get(page.projectId)
      if (project) {
        await db.projects.update(project.id, {
          updatedAt: now,
          ...(project.analysis
            ? {
                analysis: {
                  ...project.analysis,
                  pages: project.analysis.pages.map((spec) =>
                    spec.id === page.spec.id ? { ...spec, name: trimmed } : spec,
                  ),
                },
              }
            : {}),
        })
      }
    })
  },

  listByProject(projectId: string): Promise<Page[]> {
    return db.pages.where('projectId').equals(projectId).sortBy('sortOrder')
  },

  get(id: string): Promise<Page | undefined> {
    return db.pages.get(id)
  },

  async bulkCreate(pages: Page[]): Promise<void> {
    await db.pages.bulkAdd(pages)
  },

  async create(page: Page): Promise<void> {
    await db.pages.add(page)
  },

  /** Patch only hierarchy fields so a simultaneous generation cannot lose its version/status. */
  async saveHierarchy(projectId: string, pages: Page[]): Promise<void> {
    await db.transaction('rw', [db.pages, db.projects], async () => {
      const now = Date.now()
      for (const page of pages) {
        const existing = await db.pages.get(page.id)
        if (!existing || existing.projectId !== projectId)
          throw new Error('页面已变更，请刷新后重试')
        await db.pages.update(page.id, {
          spec: page.spec,
          sortOrder: page.sortOrder,
          updatedAt: now,
        })
      }
      const project = await db.projects.get(projectId)
      if (!project) throw new Error('项目不存在')
      await db.projects.update(projectId, {
        updatedAt: now,
        ...(project.analysis
          ? { analysis: { ...project.analysis, pages: pages.map((page) => page.spec) } }
          : {}),
      })
    })
  },

  async update(id: string, patch: Partial<Omit<Page, 'id'>>): Promise<void> {
    await db.pages.update(id, { ...patch, updatedAt: Date.now() })
  },

  async remove(id: string): Promise<void> {
    await db.transaction('rw', [db.pages, db.pageVersions], async () => {
      await db.pageVersions.where('pageId').equals(id).delete()
      await db.pages.delete(id)
    })
  },

  /** 刷新/崩溃后残留的 generating/queued 状态重置为 failed */
  async resetStale(projectId: string): Promise<void> {
    await db.pages
      .where('projectId')
      .equals(projectId)
      .filter((p) => p.genStatus === 'generating' || p.genStatus === 'queued')
      .modify({ genStatus: 'failed', errorMessage: '生成被中断，可重试' })
  },
}

export const versionRepo = {
  async initializeHtml(projectId: string, pageId: string, html: string): Promise<PageVersion> {
    if (!html.trim()) throw new Error('HTML 内容不能为空')
    if (new TextEncoder().encode(html).length > 5 * 1024 * 1024)
      throw new Error('HTML 文件不能超过 5 MB')
    return db.transaction('rw', [db.pages, db.pageVersions], async () => {
      const page = await db.pages.get(pageId)
      if (!page || page.projectId !== projectId) throw new Error('页面不存在或不属于当前迭代')
      if (page.spec.groupOnly) throw new Error('导航分组不能导入 HTML，请先改为普通页面')
      if (page.genStatus === 'queued' || page.genStatus === 'generating')
        throw new Error('页面正在生成或排队，请先停止')
      if (page.currentVersionId || (await db.pageVersions.where('pageId').equals(pageId).count()))
        throw new Error('页面已有内容，不能通过初始化导入覆盖')
      return versionRepo.add(pageId, html, 'import', '手动导入 HTML 初始化页面')
    })
  },
  async importLayrr(
    projectId: string,
    pageId: string,
    baseline: string,
    html: string,
  ): Promise<PageVersion> {
    return db.transaction('rw', [db.pages, db.pageVersions], async () => {
      const page = await db.pages.get(pageId)
      if (!page || page.projectId !== projectId || page.spec.groupOnly)
        throw new Error('原页面已删除或不属于此迭代')
      if (page.currentVersionId !== baseline)
        throw new Error('页面已产生新版本，请重新打开 Layrr，避免覆盖其他修改')
      if (page.genStatus === 'queued' || page.genStatus === 'generating')
        throw new Error('页面仍在生成，请停止后再保存')
      const original = await db.pageVersions.get(baseline)
      if (!original || original.pageId !== pageId) throw new Error('原始版本不匹配')
      if (!html.trim() || original.html === html) throw new Error('没有需要保存的修改')
      return versionRepo.add(pageId, html, 'layrr', 'Layrr 局部修改')
    })
  },
  async listByPage(pageId: string): Promise<PageVersion[]> {
    const versions = await db.pageVersions.where('pageId').equals(pageId).sortBy('versionNumber')
    return versions.reverse()
  },

  get(id: string): Promise<PageVersion | undefined> {
    return db.pageVersions.get(id)
  },

  /** 新增版本：写版本、置为当前版本、裁剪历史 */
  async add(
    pageId: string,
    html: string,
    source: PageVersionSource,
    feedbackText?: string,
  ): Promise<PageVersion> {
    return db.transaction('rw', [db.pages, db.pageVersions], async () => {
      const existing = await db.pageVersions.where('pageId').equals(pageId).sortBy('versionNumber')
      const version: PageVersion = {
        id: nanoid(),
        pageId,
        versionNumber: (existing.at(-1)?.versionNumber ?? 0) + 1,
        html,
        source,
        feedbackText,
        createdAt: Date.now(),
      }
      await db.pageVersions.add(version)
      await db.pages.update(pageId, {
        currentVersionId: version.id,
        genStatus: 'done',
        errorMessage: undefined,
        updatedAt: Date.now(),
      })
      if (existing.length + 1 > MAX_VERSIONS_PER_PAGE) {
        const surplus = existing.slice(0, existing.length + 1 - MAX_VERSIONS_PER_PAGE)
        await db.pageVersions.bulkDelete(surplus.map((v) => v.id))
      }
      return version
    })
  },
}

export const docRepo = {
  async bulkCreate(docs: SourceDoc[]): Promise<void> {
    await db.sourceDocs.bulkAdd(docs)
  },

  listByProject(projectId: string): Promise<SourceDoc[]> {
    return db.sourceDocs.where('projectId').equals(projectId).toArray()
  },
}

export const assetRepo = {
  async bulkCreate(assets: StoredAsset[]): Promise<void> {
    await db.assets.bulkAdd(assets)
  },

  listByProject(projectId: string): Promise<StoredAsset[]> {
    return db.assets.where('projectId').equals(projectId).toArray()
  },
}

/** 工作台一次性读取：项目 + 页面 + 当前版本 HTML */
export async function loadWorkbench(projectId: string): Promise<{
  project: Project
  pages: Page[]
  htmlByPage: Map<string, string>
} | null> {
  const project = await db.projects.get(projectId)
  if (!project) return null
  await pageRepo.resetStale(projectId)
  const pages = await pageRepo.listByProject(projectId)
  const versionIds = pages.map((p) => p.currentVersionId).filter((v): v is string => !!v)
  const versions = await db.pageVersions.bulkGet(versionIds)
  const htmlByPage = new Map<string, string>()
  for (const v of versions) {
    if (v) htmlByPage.set(v.pageId, v.html)
  }
  return { project, pages, htmlByPage }
}

export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}
