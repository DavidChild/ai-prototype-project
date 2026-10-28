import type { Page } from '@/types/page'
import type { Project } from '@/types/project'
import type { ProviderConfig } from '@/types/provider'
import type { ImportedPagePromptContext } from '@/prompts/pageGeneration'
import { normalizePageImportModificationRules } from '@/types/analysis'
import { loadWorkbench, pageRepo, versionRepo } from '@/services/storage/repositories'
import { generatePageHtml } from './generatePage'
import { refinePageHtml } from './refinePage'

function menuTree(pages: Page[]): string {
  const bySpecId = new Map(pages.map((page) => [page.spec.id, page]))
  return pages
    .map((page) => `${page.spec.parentId && bySpecId.has(page.spec.parentId) ? '  -' : '-'} ${page.spec.name}`)
    .join('\n')
}

function importedPageContext(
  page: Page,
  pages: Page[],
  htmlByPage: Map<string, string>,
): ImportedPagePromptContext[] {
  return (page.spec.importedPages ?? []).flatMap((reference) => {
    const imported = pages.find((candidate) => candidate.id === reference.pageId)
    const html = imported ? htmlByPage.get(imported.id) : undefined
    if (!imported || !html) return []
    return [{
      pageId: imported.id,
      name: imported.spec.name,
      html,
      access: 'readonly' as const,
      modificationRules: normalizePageImportModificationRules(reference.modificationRules),
    }]
  })
}

function refinementFeedback(project: Project, page: Page): string {
  const requirement = project.iterationRequirement!
  const change = page.spec.iterationChange!
  const related = requirement.relatedPages.filter((item) =>
    change.relatedPageIds.includes(item.pageId),
  )
  return [
    `【${project.iteration ?? '当前版本'} 初始需求变更】`,
    requirement.productNature ? `目标端性质：${requirement.productNature}` : '',
    `必须基于当前复制自 ${requirement.sourceIteration} 的旧页面做增量修改，未被需求涉及的结构、功能和视觉保持原样。`,
    `当前页变更原因：${change.reason}`,
    `版本需求：${requirement.text.slice(0, 12000)}`,
    related.length
      ? `同步关联的其他端页面（只用于业务一致性，不照搬端侧布局）：\n${related
          .map(
            (item) =>
              `- ${item.projectName} / ${item.iteration} / ${item.pageName}：${item.description || '无页面描述'}${item.blocks.length ? `；区块：${item.blocks.join('、')}` : ''}`,
          )
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export interface InitializeIterationInput {
  project: Project
  provider: ProviderConfig
  model: string
  maxTokens: number
  temperature: number
  tailwindCdnUrl: string
  concurrency: number
  signal?: AbortSignal
  onProgress?: (done: number, total: number, pageName: string) => void
  onPageChange?: (event: InitializeIterationPageEvent) => void
}

export interface InitializeIterationPageEvent {
  pageId: string
  pageName: string
  status: 'generating' | 'completed' | 'failed'
  done: number
  total: number
  html?: string
  error?: string
}

export interface InitializeIterationResult {
  completed: number
  failed: Array<{ pageId: string; pageName: string; error: string }>
}

export async function initializeIterationProject(
  input: InitializeIterationInput,
): Promise<InitializeIterationResult> {
  const data = await loadWorkbench(input.project.id)
  if (!data) throw new Error('新版本不存在或没有访问权限')
  const targets = data.pages.filter(
    (page) => !page.spec.groupOnly && !!page.spec.iterationChange && !page.iterationInitialized,
  )
  const result: InitializeIterationResult = { completed: 0, failed: [] }
  let cursor = 0
  const worker = async () => {
    while (cursor < targets.length) {
      input.signal?.throwIfAborted()
      const page = targets[cursor++]!
      input.onProgress?.(result.completed + result.failed.length, targets.length, page.spec.name)
      await pageRepo.update(page.id, { genStatus: 'generating', errorMessage: undefined })
      input.onPageChange?.({
        pageId: page.id,
        pageName: page.spec.name,
        status: 'generating',
        done: result.completed + result.failed.length,
        total: targets.length,
      })
      try {
        const currentHtml = data.htmlByPage.get(page.id)
        const importedPages = importedPageContext(page, data.pages, data.htmlByPage)
        let html: string
        let source: 'generate' | 'refine'
        if (page.spec.iterationChange?.action === 'update' && currentHtml) {
          html = await refinePageHtml({
            provider: input.provider,
            model: input.model,
            platform: input.project.platform,
            styleSpec: input.project.styleSpec,
            currentHtml,
            feedback: refinementFeedback(input.project, page),
            constraints: page.spec.constraints,
            importedPages,
            generationMode: 'current',
            maxTokens: input.maxTokens,
            temperature: input.temperature,
            tailwindCdnUrl: input.tailwindCdnUrl,
            signal: input.signal,
          })
          source = 'refine'
        } else {
          html = await generatePageHtml({
            provider: input.provider,
            model: input.model,
            platform: input.project.platform,
            styleSpec: input.project.styleSpec,
            page: page.spec,
            context: {
              productName: input.project.analysis?.productName ?? input.project.name,
              overview: input.project.analysis?.overview ?? '',
              targetUsers: input.project.analysis?.targetUsers,
              menuTree: menuTree(data.pages),
              parentName: page.spec.parentId
                ? data.pages.find((candidate) => candidate.spec.id === page.spec.parentId)?.spec.name
                : undefined,
              importedPages,
              generationMode: 'current',
              iterationRequirement: input.project.iterationRequirement,
            },
            maxTokens: input.maxTokens,
            temperature: input.temperature,
            tailwindCdnUrl: input.tailwindCdnUrl,
            signal: input.signal,
          })
          source = 'generate'
        }
        await versionRepo.add(
          page.id,
          html,
          source,
          `${input.project.iteration ?? '当前版本'} 初始需求变更：${page.spec.iterationChange?.reason ?? '版本需求'}`,
        )
        await pageRepo.update(page.id, { iterationInitialized: true })
        result.completed++
        input.onPageChange?.({
          pageId: page.id,
          pageName: page.spec.name,
          status: 'completed',
          done: result.completed + result.failed.length,
          total: targets.length,
          html,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : '页面初始迭代失败'
        result.failed.push({ pageId: page.id, pageName: page.spec.name, error: message })
        await pageRepo.update(page.id, { genStatus: 'failed', errorMessage: message }).catch(() => {})
        input.onPageChange?.({
          pageId: page.id,
          pageName: page.spec.name,
          status: 'failed',
          done: result.completed + result.failed.length,
          total: targets.length,
          error: message,
        })
      }
      input.onProgress?.(
        result.completed + result.failed.length,
        targets.length,
        page.spec.name,
      )
    }
  }
  const workers = Array.from(
    { length: Math.min(Math.max(1, Math.floor(input.concurrency)), targets.length || 1) },
    () => worker(),
  )
  await Promise.all(workers)
  input.onProgress?.(targets.length, targets.length, '')
  return result
}
