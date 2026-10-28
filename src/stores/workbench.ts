import { computed, reactive, ref } from 'vue'
import { acceptHMRUpdate, defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import { normalizePageImportModificationRules, type PageSpec } from '@/types/analysis'
import type { Page, PageVersion, PageVersionSource } from '@/types/page'
import type { ExtractedImage } from '@/types/parsing'
import type { Project } from '@/types/project'
import type { GenerationConstraint } from '@/types/generationConstraint'
import { buildGenerationConstraints } from '@/prompts/generationConstraints'
import { LLMError } from '@/services/llm/errors'
import { generatePageHtml } from '@/services/generation/generatePage'
import {
  generateRelatedPages,
  type RelatedPageChange,
} from '@/services/generation/generateRelatedPages'
import { extractPrototypeStyle } from '@/services/generation/prototypeStyle'
import { refinePageHtml } from '@/services/generation/refinePage'
import { GenerationScheduler } from '@/services/generation/scheduler'
import { loadWorkbench, pageRepo, projectRepo, versionRepo } from '@/services/storage/repositories'
import { useSettingsStore } from './settings'
import { movePageTree, pageTreeRows, type PageDropPosition } from '@/utils/pageTree'
import { pageTypeLockReason } from '@/utils/pageEditing'
import { uniquePageName } from '@/utils/pageName'
import type { ImportedPagePromptContext } from '@/prompts/pageGeneration'
import type { AnnotationStore } from 'web-remarq'

export interface StreamState {
  text: string
  reasoning: string
}

export interface RefineChatEntry {
  id: string
  role: 'user' | 'assistant'
  text: string
  failed?: boolean
}

function plainClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type GenerationOutput =
  | {
      kind: 'single'
      html: string
      source: PageVersionSource
      feedbackText?: string
      iterationInitial?: boolean
    }
  | {
      kind: 'related'
      changes: RelatedPageChange[]
      allowedUpdateIds: string[]
      baselines: Record<string, string | undefined>
    }
type RelatedGenerationOutput = Extract<GenerationOutput, { kind: 'related' }>

export const useWorkbenchStore = defineStore('workbench', () => {
  const settings = useSettingsStore()

  const project = ref<Project | null>(null)
  const pages = ref<Page[]>([])
  const htmlByPage = reactive(new Map<string, string>())
  const streams = reactive(new Map<string, StreamState>())
  const selectedPageId = ref<string | null>(null)
  const versions = ref<PageVersion[]>([])
  const loading = ref(false)
  const loadError = ref('')
  const hierarchySaving = ref(false)
  const pageSearchQuery = ref('')
  const exportSelectedPageIds = ref<string[]>([])
  const pageRows = computed(() => pageTreeRows(pages.value))

  const refining = ref(false)
  const localEditingPageId = ref<string | null>(null)
  const refineStream = reactive<StreamState>({ text: '', reasoning: '' })
  const refineChats = reactive(new Map<string, RefineChatEntry[]>())
  let refineAbort: AbortController | null = null

  let scheduler: GenerationScheduler<GenerationOutput> | null = null
  let loadSequence = 0
  let historySequence = 0

  const selectedPage = computed(
    () => pages.value.find((p) => p.id === selectedPageId.value) ?? null,
  )
  const selectedHtml = computed(() =>
    selectedPageId.value ? (htmlByPage.get(selectedPageId.value) ?? '') : '',
  )
  const selectedStream = computed(() =>
    selectedPageId.value ? (streams.get(selectedPageId.value) ?? null) : null,
  )
  const selectedChat = computed(() => {
    if (!selectedPageId.value) return []
    let chat = refineChats.get(selectedPageId.value)
    if (!chat) {
      chat = []
      refineChats.set(selectedPageId.value, chat)
    }
    return chat
  })

  const progress = computed(() => {
    const real = pages.value.filter((p) => !p.spec.groupOnly)
    const total = real.length
    const done = real.filter((p) => p.genStatus === 'done').length
    const active = real.filter(
      (p) => p.genStatus === 'generating' || p.genStatus === 'queued',
    ).length
    const failed = real.filter((p) => p.genStatus === 'failed').length
    return { total, done, active, failed }
  })

  /** 两级菜单树：一级（含纯分组）+ 其二级页面；父级丢失的孤儿按一级展示 */
  const menuGroups = computed(() => {
    const tops = pages.value.filter((p) => !p.spec.parentId)
    const topSpecIds = new Set(tops.map((t) => t.spec.id))
    const groups = tops.map((top) => ({
      top,
      children: pages.value.filter((p) => p.spec.parentId === top.spec.id),
    }))
    for (const orphan of pages.value.filter(
      (p) => p.spec.parentId && !topSpecIds.has(p.spec.parentId),
    )) {
      groups.push({ top: orphan, children: [] })
    }
    return groups
  })

  function buildMenuTreeText(): string {
    return pageRows.value
      .map(
        ({ page, depth }) =>
          `${'  '.repeat(depth)}- ${page.spec.name}${page.spec.groupOnly ? '（分组，无独立页面）' : ''}`,
      )
      .join('\n')
  }

  function buildImportedPageContext(page: Page): ImportedPagePromptContext[] {
    const references = page.spec.importedPages ?? []
    const result: ImportedPagePromptContext[] = []
    let remaining = 160_000
    for (const [referenceIndex, reference] of references.entries()) {
      const imported = pageOf(reference.pageId)
      const html = imported ? htmlByPage.get(imported.id) : undefined
      if (
        !imported ||
        imported.spec.groupOnly ||
        !html ||
        imported.id === page.id ||
        remaining <= 0
      )
        continue
      const content = html.slice(0, Math.min(80_000, remaining))
      remaining -= content.length
      result.push({
        pageId: imported.id,
        name: imported.spec.name,
        html: content,
        access:
          page.spec.generationMode === 'smart-related' && reference.access === 'editable'
            ? 'editable'
            : 'readonly',
        modificationRules:
          ((page.spec.generationMode === 'smart-related' && reference.access === 'editable') ||
            (page.spec.generationMode === 'from-import' && referenceIndex === 0))
            ? normalizePageImportModificationRules(reference.modificationRules)
            : undefined,
      })
    }
    return result
  }

  async function applyRelatedGeneration(
    pageId: string,
    result: RelatedGenerationOutput,
    sequence: number,
    source: 'generate' | 'refine' = 'generate',
  ): Promise<string[]> {
    const requestPage = pageOf(pageId)
    if (!requestPage) return []
    const allowed = new Set(result.allowedUpdateIds)
    const changedNames: string[] = []
    let requestUpdated = false
    let selectedUpdated = false
    let createdRelatedPage = false
    for (const change of result.changes) {
      if (sequence !== loadSequence) return changedNames
      if (change.action === 'update' && change.pageId && allowed.has(change.pageId)) {
        const target = pageOf(change.pageId)
        if (
          !target ||
          target.spec.groupOnly ||
          target.currentVersionId !== result.baselines[target.id] ||
          (target.id !== pageId && ['queued', 'generating'].includes(target.genStatus)) ||
          localEditingPageId.value === target.id
        )
          continue
        const version = await versionRepo.add(target.id, change.html, source, change.reason)
        if (sequence !== loadSequence) return changedNames
        htmlByPage.set(target.id, change.html)
        target.currentVersionId = version.id
        target.genStatus = 'done'
        target.errorMessage = undefined
        target.reviewPending = true
        requestUpdated ||= target.id === pageId
        selectedUpdated ||= target.id === selectedPageId.value
        changedNames.push(target.spec.name)
      } else if (change.action === 'create') {
        const id = nanoid()
        const baseName = change.name.trim() || '关联页面'
        const name = uniquePageName(
          baseName,
          pages.value.map((candidate) => candidate.spec.name),
          project.value?.iteration ?? 'v1.0',
        )
        const created: Page = {
          id,
          projectId: requestPage.projectId,
          spec: {
            id,
            name,
            parentId: requestPage.spec.parentId,
            description: change.reason,
            blocks: [],
            generationMode: 'current',
          },
          sortOrder: (pages.value.at(-1)?.sortOrder ?? 0) + 1,
          genStatus: 'done',
          reviewPending: true,
          updatedAt: Date.now(),
        }
        await pageRepo.create(plainClone(created))
        let version: PageVersion
        try {
          version = await versionRepo.add(id, change.html, source, change.reason)
        } catch (error) {
          await pageRepo.remove(id).catch(() => {})
          throw error
        }
        if (sequence !== loadSequence) return changedNames
        created.currentVersionId = version.id
        pages.value.push(created)
        htmlByPage.set(id, change.html)
        createdRelatedPage = true
        changedNames.push(name)
        if (project.value?.analysis) project.value.analysis.pages.push(plainClone(created.spec))
      }
    }
    if (createdRelatedPage && project.value?.analysis)
      await projectRepo.update(project.value.id, {
        analysis: plainClone(project.value.analysis),
      })
    if (!requestUpdated) {
      requestPage.genStatus = htmlByPage.has(pageId) ? 'done' : 'idle'
      requestPage.errorMessage = undefined
      await pageRepo.update(pageId, {
        genStatus: requestPage.genStatus,
        errorMessage: undefined,
      })
    }
    if (selectedUpdated || selectedPageId.value === pageId) void loadVersions()
    return changedNames
  }

  async function movePage(
    pageId: string,
    targetId: string | null,
    position: PageDropPosition,
  ): Promise<void> {
    const proj = project.value
    if (!proj) throw new Error('项目尚未加载')
    if (hierarchySaving.value) throw new Error('正在保存页面层级，请稍候')
    const moved = movePageTree(pages.value, pageId, targetId, position)
    if (
      moved.every(
        (page, i) =>
          page.id === pages.value[i]?.id &&
          page.sortOrder === pages.value[i]?.sortOrder &&
          page.spec.parentId === pages.value[i]?.spec.parentId,
      )
    )
      return
    hierarchySaving.value = true
    try {
      await pageRepo.saveHierarchy(proj.id, plainClone(moved))
      if (project.value?.id !== proj.id) return
      const current = new Map(pages.value.map((page) => [page.id, page]))
      pages.value = moved.map((page) => ({
        ...current.get(page.id)!,
        spec: page.spec,
        sortOrder: page.sortOrder,
      }))
      if (proj.analysis) proj.analysis.pages = pages.value.map((page) => plainClone(page.spec))
    } finally {
      hierarchySaving.value = false
    }
  }

  function pageOf(pageId: string): Page | undefined {
    return pages.value.find((p) => p.id === pageId)
  }

  function setPageStatus(
    pageId: string,
    status: 'queued' | 'generating' | 'failed',
    error?: string,
  ): void {
    const page = pageOf(pageId)
    if (!page) return
    if (status === 'failed' && error === '已取消') {
      page.genStatus = htmlByPage.has(pageId) ? 'done' : 'idle'
      page.errorMessage = undefined
      streams.delete(pageId)
      void pageRepo.update(pageId, { genStatus: page.genStatus, errorMessage: undefined })
      return
    }
    page.genStatus = status
    page.errorMessage = error
    if (status === 'generating') streams.set(pageId, { text: '', reasoning: '' })
    if (status === 'failed') {
      streams.delete(pageId)
    }
    void pageRepo.update(pageId, { genStatus: status, errorMessage: error })
  }

  function resolveGenerationModel() {
    const resolved = settings.resolveModel('generation', project.value?.modelOverride ?? undefined)
    if (!resolved) {
      throw new LLMError('bad_request', '未配置「页面生成模型」，请先到模型设置配置')
    }
    return resolved
  }

  function makeScheduler(): GenerationScheduler<GenerationOutput> {
    const sequence = loadSequence
    return new GenerationScheduler<GenerationOutput>({
      concurrency: () => settings.genParams.concurrency,
      generate: (page, signal, onDelta, onReasoningDelta) => {
        if (sequence !== loadSequence || signal.aborted)
          throw new DOMException('Aborted', 'AbortError')
        const resolved = resolveGenerationModel()
        const proj = project.value!
        const analysis = proj.analysis
        const importedPages = buildImportedPageContext(page)
        const stylePage = page.spec.referenceDesign
          ? [
              page,
              ...pages.value.filter((candidate) => candidate.spec.parentId === page.spec.parentId),
              ...pages.value,
            ].find((candidate) => !candidate.spec.groupOnly && htmlByPage.has(candidate.id))
          : undefined
        const input = {
          provider: resolved.provider,
          model: resolved.model,
          platform: proj.platform,
          styleSpec: proj.styleSpec,
          page: plainClone(page.spec),
          context: {
            productName: analysis?.productName ?? proj.name,
            overview: analysis?.overview ?? '',
            targetUsers: analysis?.targetUsers,
            menuTree: buildMenuTreeText(),
            parentName: page.spec.parentId
              ? pages.value.find((p) => p.spec.id === page.spec.parentId)?.spec.name
              : undefined,
            prototypeStyle: stylePage
              ? {
                  pageName: stylePage.spec.name,
                  summary: extractPrototypeStyle(htmlByPage.get(stylePage.id)!),
                }
              : undefined,
            importedPages,
            generationMode: page.spec.generationMode ?? 'current',
            iterationRequirement: page.iterationInitialized
              ? undefined
              : proj.iterationRequirement,
          },
          maxTokens: settings.genParams.maxTokens,
          temperature: settings.genParams.temperature,
          tailwindCdnUrl: settings.genParams.tailwindCdnUrl,
          signal,
          onDelta,
          onReasoningDelta,
        }
        const iterationChange = page.spec.iterationChange
        const iterationRequirement = proj.iterationRequirement
        const currentHtml = htmlByPage.get(page.id)
        if (
          iterationChange?.action === 'update' &&
          iterationRequirement &&
          !page.iterationInitialized &&
          currentHtml
        ) {
          const related = iterationRequirement.relatedPages.filter((item) =>
            iterationChange.relatedPageIds.includes(item.pageId),
          )
          const feedback = [
            `【${proj.iteration ?? '当前版本'} 初始需求变更】`,
            iterationRequirement.productNature
              ? `目标端性质：${iterationRequirement.productNature}`
              : '',
            `必须基于当前复制自 ${iterationRequirement.sourceIteration} 的旧页面做增量修改，未被需求涉及的结构、功能和视觉保持原样。`,
            `当前页变更原因：${iterationChange.reason}`,
            `版本需求：${iterationRequirement.text.slice(0, 12000)}`,
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
          return refinePageHtml({
            provider: resolved.provider,
            model: resolved.model,
            platform: proj.platform,
            styleSpec: proj.styleSpec,
            currentHtml,
            feedback,
            constraints: page.spec.constraints ? plainClone(page.spec.constraints) : undefined,
            importedPages,
            generationMode: 'current',
            maxTokens: settings.genParams.maxTokens,
            temperature: settings.genParams.temperature,
            tailwindCdnUrl: settings.genParams.tailwindCdnUrl,
            signal,
            onDelta,
            onReasoningDelta,
          }).then((html) => ({
            kind: 'single' as const,
            html,
            source: 'refine' as const,
            feedbackText: `${proj.iteration ?? '当前版本'} 初始需求变更：${iterationChange.reason}`,
            iterationInitial: true,
          }))
        }
        if (page.spec.generationMode === 'smart-related') {
          const allowedUpdateIds = [
            page.id,
            ...importedPages
              .filter((imported) => imported.access === 'editable')
              .map((imported) => imported.pageId),
          ]
          const baselines = Object.fromEntries(
            allowedUpdateIds.map((id) => [id, pageOf(id)?.currentVersionId]),
          )
          return generateRelatedPages({ ...input, currentPageId: page.id }).then((changes) => ({
            kind: 'related' as const,
            changes,
            allowedUpdateIds,
            baselines,
          }))
        }
        const iterationInitial = !!iterationChange && !page.iterationInitialized
        return generatePageHtml(input).then((html) => ({
          kind: 'single' as const,
          html,
          source: 'generate' as const,
          feedbackText: iterationInitial
            ? `${proj.iteration ?? '当前版本'} 初始需求变更：${iterationChange.reason}`
            : undefined,
          iterationInitial,
        }))
      },
      callbacks: {
        onStatus: (id, status, error) => {
          if (sequence === loadSequence) setPageStatus(id, status, error)
        },
        onDelta: (pageId, t) => {
          const s = streams.get(pageId)
          if (s) s.text += t
        },
        onReasoningDelta: (pageId, t) => {
          const s = streams.get(pageId)
          if (s) s.reasoning += t
        },
        onSuccess: async (pageId, result) => {
          if (sequence !== loadSequence || !pageOf(pageId)) return
          if (result.kind === 'single') {
            const version = await versionRepo.add(
              pageId,
              result.html,
              result.source,
              result.feedbackText,
            )
            if (sequence !== loadSequence) return
            htmlByPage.set(pageId, result.html)
            const page = pageOf(pageId)
            if (page) {
              page.genStatus = 'done'
              page.errorMessage = undefined
              page.currentVersionId = version.id
              page.reviewPending = true
              if (result.iterationInitial) {
                page.iterationInitialized = true
                await pageRepo.update(page.id, { iterationInitialized: true })
              }
            }
          } else {
            await applyRelatedGeneration(pageId, result, sequence)
          }
          streams.delete(pageId)
          if (selectedPageId.value === pageId) void loadVersions()
        },
      },
    })
  }

  async function load(projectId: string, autostart = false): Promise<void> {
    scheduler?.cancelAll()
    pageSearchQuery.value = ''
    exportSelectedPageIds.value = []
    scheduler = null
    refineAbort?.abort()
    refineAbort = null
    refining.value = false
    refineStream.text = ''
    refineStream.reasoning = ''
    const sequence = ++loadSequence
    ++historySequence
    versions.value = []
    loading.value = true
    loadError.value = ''
    try {
      const data = await loadWorkbench(projectId)
      if (sequence !== loadSequence) return
      if (!data) {
        loadError.value = '项目不存在或已被删除'
        project.value = null
        pages.value = []
        return
      }
      project.value = data.project
      pages.value = data.pages
      htmlByPage.clear()
      for (const [k, v] of data.htmlByPage) htmlByPage.set(k, v)
      streams.clear()
      refineChats.clear()
      scheduler = makeScheduler()
      selectedPageId.value =
        data.pages.find((p) => !p.spec.groupOnly)?.id ?? data.pages[0]?.id ?? null
      await loadVersions()
      if (sequence !== loadSequence) return
      if (autostart) {
        generatePages(pages.value.filter((p) => p.genStatus !== 'done').map((p) => p.id))
      }
    } catch (error) {
      if (sequence === loadSequence)
        loadError.value = error instanceof Error ? error.message : '项目加载失败'
    } finally {
      if (sequence === loadSequence) loading.value = false
    }
  }

  function generatePages(pageIds: string[]): number {
    if (!scheduler) return 0
    const targets = pageIds
      .map((id) => pageOf(id))
      .filter(
        (p): p is Page =>
          !!p &&
          !p.spec.groupOnly &&
          p.id !== localEditingPageId.value &&
          !scheduler!.isActive(p.id),
      )
    if (targets.length) scheduler.enqueue(targets)
    return targets.length
  }

  function regenerateSelected(): boolean {
    return selectedPageId.value ? generatePages([selectedPageId.value]) > 0 : false
  }

  function retryFailed(): void {
    generatePages(pages.value.filter((p) => p.genStatus === 'failed').map((p) => p.id))
  }

  function cancelPage(pageId: string): void {
    scheduler?.cancel(pageId)
  }

  function cancelAll(): void {
    scheduler?.cancelAll()
  }

  function selectPage(pageId: string): void {
    selectedPageId.value = pageId
    void loadVersions()
  }

  async function loadVersions(): Promise<void> {
    const sequence = ++historySequence
    const pageId = selectedPageId.value
    versions.value = []
    const result = pageId ? await versionRepo.listByPage(pageId) : []
    if (sequence === historySequence && selectedPageId.value === pageId) versions.value = result
  }

  async function refineSelected(feedback: string, images?: ExtractedImage[]): Promise<void> {
    const page = selectedPage.value
    const currentHtml = selectedHtml.value
    if (!page || !currentHtml || refining.value || localEditingPageId.value === page.id) return
    const chat = selectedChat.value
    const imageNote = images?.length ? `（附 ${images.length} 张参考图）` : ''
    chat.push({ id: nanoid(), role: 'user', text: feedback + imageNote })
    refining.value = true
    refineStream.text = ''
    refineStream.reasoning = ''
    refineAbort = new AbortController()
    const controller = refineAbort
    const sequence = loadSequence
    try {
      const resolved = resolveGenerationModel()
      const proj = project.value!
      const importedPages = buildImportedPageContext(page)
      if (page.spec.generationMode === 'smart-related') {
        const allowedUpdateIds = [
          page.id,
          ...importedPages
            .filter((imported) => imported.access === 'editable')
            .map((imported) => imported.pageId),
        ]
        const baselines = Object.fromEntries(
          allowedUpdateIds.map((id) => [id, pageOf(id)?.currentVersionId]),
        )
        const analysis = proj.analysis
        const changes = await generateRelatedPages({
          provider: resolved.provider,
          model: resolved.model,
          platform: proj.platform,
          styleSpec: proj.styleSpec,
          page: plainClone(page.spec),
          currentPageId: page.id,
          currentHtml,
          feedback,
          images,
          context: {
            productName: analysis?.productName ?? proj.name,
            overview: analysis?.overview ?? '',
            targetUsers: analysis?.targetUsers,
            menuTree: buildMenuTreeText(),
            parentName: page.spec.parentId
              ? pages.value.find((candidate) => candidate.spec.id === page.spec.parentId)?.spec.name
              : undefined,
            importedPages,
            generationMode: 'smart-related',
          },
          maxTokens: settings.genParams.maxTokens,
          temperature: settings.genParams.temperature,
          tailwindCdnUrl: settings.genParams.tailwindCdnUrl,
          signal: controller.signal,
          onDelta: (text) => {
            if (sequence === loadSequence) refineStream.text += text
          },
          onReasoningDelta: (text) => {
            if (sequence === loadSequence) refineStream.reasoning += text
          },
        })
        if (sequence !== loadSequence || controller.signal.aborted) return
        const changedNames = await applyRelatedGeneration(
          page.id,
          { kind: 'related', changes, allowedUpdateIds, baselines },
          sequence,
          'refine',
        )
        chat.push({
          id: nanoid(),
          role: 'assistant',
          text: changedNames.length
            ? `已完成关联修改：${changedNames.join('、')}，请在左侧逐页审阅确认。`
            : 'AI 判断本次无需产生页面变更。',
        })
        return
      }
      const html = await refinePageHtml({
        provider: resolved.provider,
        model: resolved.model,
        platform: proj.platform,
        styleSpec: proj.styleSpec,
        currentHtml,
        feedback,
        images,
        constraints: page.spec.constraints ? plainClone(page.spec.constraints) : undefined,
        importedPages,
        generationMode: page.spec.generationMode,
        maxTokens: settings.genParams.maxTokens,
        temperature: settings.genParams.temperature,
        tailwindCdnUrl: settings.genParams.tailwindCdnUrl,
        signal: controller.signal,
        onDelta: (t) => {
          if (sequence === loadSequence) refineStream.text += t
        },
        onReasoningDelta: (t) => {
          if (sequence === loadSequence) refineStream.reasoning += t
        },
      })
      if (sequence !== loadSequence || controller.signal.aborted) return
      const version = await versionRepo.add(page.id, html, 'refine', feedback)
      if (sequence !== loadSequence) return
      htmlByPage.set(page.id, html)
      page.currentVersionId = version.id
      page.genStatus = 'done'
      page.errorMessage = undefined
      page.reviewPending = true
      await loadVersions()
      chat.push({ id: nanoid(), role: 'assistant', text: `已更新到 v${version.versionNumber}` })
    } catch (e) {
      const isAbort =
        (e instanceof LLMError && e.kind === 'abort') ||
        (e instanceof DOMException && e.name === 'AbortError')
      chat.push({
        id: nanoid(),
        role: 'assistant',
        text: isAbort ? '已取消' : `修改失败：${(e as Error).message}`,
        failed: !isAbort,
      })
    } finally {
      if (refineAbort === controller) {
        refining.value = false
        refineAbort = null
        refineStream.text = ''
        refineStream.reasoning = ''
      }
    }
  }

  function cancelRefine(): void {
    refineAbort?.abort()
  }

  async function rollbackTo(version: PageVersion): Promise<void> {
    if (localEditingPageId.value === version.pageId) return
    if (loading.value || !pageOf(version.pageId) || selectedPageId.value !== version.pageId) return
    const sequence = loadSequence
    const restored = await versionRepo.add(version.pageId, version.html, 'rollback')
    if (sequence !== loadSequence) return
    htmlByPage.set(version.pageId, version.html)
    const page = pageOf(version.pageId)
    if (page) {
      page.currentVersionId = restored.id
      page.genStatus = 'done'
      page.reviewPending = false
    }
    await loadVersions()
  }

  async function renamePage(pageId: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('页面名不能为空')
    if (hierarchySaving.value) throw new Error('正在保存页面层级，请稍候')
    const page = pageOf(pageId)
    if (!page) throw new Error('页面不存在，请刷新后重试')
    const uniqueName = uniquePageName(
      trimmed,
      pages.value.map((candidate) => candidate.spec.name),
      project.value?.iteration ?? 'v1.0',
      page.spec.name,
    )
    if (page.spec.name === uniqueName) return
    await pageRepo.rename(pageId, uniqueName)
    const current = pageOf(pageId)
    if (current) current.spec = { ...current.spec, name: uniqueName }
    if (project.value?.id === page.projectId && project.value.analysis) {
      project.value.analysis.pages = project.value.analysis.pages.map((spec) =>
        spec.id === page.spec.id ? { ...spec, name: uniqueName } : spec,
      )
    }
  }

  async function copyPage(projectId: string, pageId: string, name: string): Promise<void> {
    if (loading.value || project.value?.id !== projectId || !pageOf(pageId))
      throw new Error('项目或页面已切换，请重新打开复制')
    if (hierarchySaving.value) throw new Error('正在保存页面层级，请稍候')
    if (refining.value) throw new Error('正在修改页面，请完成或停止后再复制')
    const sequence = loadSequence
    hierarchySaving.value = true
    try {
      const source = pageOf(pageId)
      const uniqueName = uniquePageName(
        name,
        pages.value.map((page) => page.spec.name),
        project.value?.iteration ?? 'v1.0',
      )
      const result = await pageRepo.copy(projectId, pageId, uniqueName)
      if (sequence !== loadSequence || project.value?.id !== projectId) return
      const current = new Map(pages.value.map((page) => [page.id, page]))
      pages.value = result.pages.map((page) => ({
        ...(current.get(page.id) ?? page),
        sortOrder: page.sortOrder,
      }))
      if (project.value.analysis)
        project.value.analysis.pages = pages.value.map((page) => plainClone(page.spec))
      project.value.updatedAt = result.updatedAt
      if (result.version) htmlByPage.set(result.page.id, result.version.html)
      selectedPageId.value = result.page.id
      await loadVersions()
    } finally {
      hierarchySaving.value = false
    }
  }

  async function importPageHtml(projectId: string, pageId: string, html: string): Promise<void> {
    if (loading.value || project.value?.id !== projectId || !pageOf(pageId))
      throw new Error('项目或页面已切换，请重新打开导入')
    const sequence = loadSequence
    const version = await versionRepo.initializeHtml(projectId, pageId, html)
    if (sequence !== loadSequence || project.value?.id !== projectId) return
    const page = pageOf(pageId)
    if (!page) return
    page.currentVersionId = version.id
    page.genStatus = 'done'
    page.errorMessage = undefined
    page.reviewPending = false
    page.updatedAt = version.createdAt
    htmlByPage.set(pageId, html)
    selectedPageId.value = pageId
    await loadVersions()
  }

  async function createImportedPage(
    name: string,
    html: string,
    parentSpecId?: string,
  ): Promise<Page> {
    const proj = project.value
    if (!proj) throw new Error('项目尚未加载')
    if (hierarchySaving.value) throw new Error('正在保存页面层级，请稍候')
    const sequence = loadSequence
    const id = nanoid()
    const uniqueName = uniquePageName(
      name,
      pages.value.map((page) => page.spec.name),
      proj.iteration ?? 'v1.0',
    )
    const created: Page = {
      id,
      projectId: proj.id,
      spec: {
        id,
        name: uniqueName,
        parentId: parentSpecId || undefined,
        description: '',
        blocks: [],
      },
      sortOrder: (pages.value.at(-1)?.sortOrder ?? 0) + 1,
      genStatus: 'idle',
      updatedAt: Date.now(),
    }
    await pageRepo.create(plainClone(created))
    let version: PageVersion
    try {
      version = await versionRepo.initializeHtml(proj.id, id, html)
    } catch (error) {
      await pageRepo.remove(id).catch(() => {})
      throw error
    }
    if (sequence !== loadSequence || project.value?.id !== proj.id) return created
    created.currentVersionId = version.id
    created.genStatus = 'done'
    created.updatedAt = version.createdAt
    pages.value.push(created)
    htmlByPage.set(id, html)
    selectedPageId.value = id
    await loadVersions()
    return created
  }

  async function savePageAnnotations(pageId: string, input: AnnotationStore): Promise<void> {
    const page = pageOf(pageId)
    if (!page || page.projectId !== project.value?.id)
      throw new Error('页面已切换，请重新打开标注模式')
    const store = await pageRepo.saveAnnotationStore(pageId, input)
    const current = pageOf(pageId)
    if (current) current.annotationStore = store
  }

  async function updateSelectedSpec(spec: PageSpec): Promise<void> {
    const page = selectedPage.value
    if (!page) return
    const projectId = project.value?.id
    const sequence = loadSequence
    if (spec.id !== page.spec.id) throw new Error('页面已切换，请重新保存')
    if (!spec.groupOnly) buildGenerationConstraints(spec.constraints)
    const importedIds = new Set<string>()
    for (const reference of spec.importedPages ?? []) {
      if (reference.pageId === page.id) throw new Error('当前页面不能引入自身')
      if (importedIds.has(reference.pageId)) throw new Error('同一个引入页不能重复添加')
      const imported = pageOf(reference.pageId)
      if (!imported || imported.projectId !== page.projectId || imported.spec.groupOnly)
        throw new Error('引入页不存在或已变更，请重新选择')
      if (!htmlByPage.has(imported.id))
        throw new Error(`引入页「${imported.spec.name}」尚无页面内容`)
      importedIds.add(reference.pageId)
    }
    if (spec.generationMode === 'from-import' && !importedIds.size)
      throw new Error('基于引入页构建时，请至少添加一个引入页')
    if (!!spec.groupOnly !== !!page.spec.groupOnly) {
      const reason = pageTypeLockReason(page, htmlByPage.has(page.id))
      if (reason) throw new Error(reason)
    }
    if (hierarchySaving.value) throw new Error('正在保存页面层级，请稍候')
    if (spec.parentId !== page.spec.parentId) {
      const target = pages.value.find((p) => p.spec.id === spec.parentId)
      if (spec.parentId && !target) throw new Error('上级页面不存在')
      await movePage(page.id, target?.id ?? null, 'inside')
    }
    if (project.value?.id !== projectId || sequence !== loadSequence)
      throw new Error('项目已切换，请重新保存')
    const current = pageOf(page.id)
    if (!current) return
    if (!!spec.groupOnly !== !!current.spec.groupOnly) {
      const reason = pageTypeLockReason(current, htmlByPage.has(current.id))
      if (reason) throw new Error(reason)
    }
    const uniqueName = uniquePageName(
      spec.name,
      pages.value.map((candidate) => candidate.spec.name),
      project.value?.iteration ?? 'v1.0',
      current.spec.name,
    )
    const savedSpec: PageSpec = plainClone({
      ...spec,
      id: current.spec.id,
      name: uniqueName,
      generationMode: spec.generationMode ?? 'current',
      importedPages: (spec.importedPages ?? []).map((reference, referenceIndex) => ({
        ...reference,
        access:
          spec.generationMode === 'smart-related' && reference.access === 'editable'
            ? ('editable' as const)
            : ('readonly' as const),
        modificationRules:
          ((spec.generationMode === 'smart-related' && reference.access === 'editable') ||
            (spec.generationMode === 'from-import' && referenceIndex === 0))
            ? normalizePageImportModificationRules(reference.modificationRules)
            : undefined,
      })),
    })
    await pageRepo.update(current.id, { spec: savedSpec })
    if (project.value?.id !== projectId || sequence !== loadSequence) return
    current.spec = savedSpec
  }

  /** 新增页面：parentSpecId 为空 = 一级菜单；groupOnly = 仅分组 */
  async function addPage(name: string, parentSpecId?: string, groupOnly = false): Promise<void> {
    const proj = project.value
    if (!proj) return
    if (hierarchySaving.value) throw new Error('正在保存页面层级，请稍候')
    const specId = nanoid()
    const uniqueName = uniquePageName(
      name,
      pages.value.map((page) => page.spec.name),
      proj.iteration ?? 'v1.0',
    )
    const page: Page = {
      id: specId,
      projectId: proj.id,
      spec: {
        id: specId,
        name: uniqueName,
        parentId: parentSpecId || undefined,
        groupOnly: groupOnly || undefined,
        description: '',
        blocks: [],
      },
      sortOrder: (pages.value.at(-1)?.sortOrder ?? 0) + 1,
      genStatus: 'idle',
      updatedAt: Date.now(),
    }
    await pageRepo.create(plainClone(page))
    if (project.value?.id !== proj.id || loading.value) return
    pages.value.push(page)
    if (!groupOnly) selectPage(page.id)
  }

  async function removePage(pageId: string): Promise<void> {
    if (hierarchySaving.value) throw new Error('正在保存页面层级，请稍候')
    if (pages.value.some((page) => page.spec.parentId === pageOf(pageId)?.spec.id)) {
      throw new Error('该菜单下还有下级页面，请先删除或移动它们')
    }
    scheduler?.cancel(pageId)
    await pageRepo.remove(pageId)
    pages.value = pages.value.filter((p) => p.id !== pageId)
    for (const page of pages.value) {
      const importedPages = page.spec.importedPages
      if (!importedPages?.some((reference) => reference.pageId === pageId)) continue
      const nextImportedPages = importedPages.filter((reference) => reference.pageId !== pageId)
      page.spec = {
        ...page.spec,
        importedPages: nextImportedPages,
      }
      if (page.spec.generationMode === 'from-import' && !nextImportedPages.length)
        page.spec.generationMode = 'current'
      await pageRepo.update(page.id, { spec: plainClone(page.spec) })
    }
    exportSelectedPageIds.value = exportSelectedPageIds.value.filter((id) => id !== pageId)
    htmlByPage.delete(pageId)
    streams.delete(pageId)
    refineChats.delete(pageId)
    if (selectedPageId.value === pageId) {
      selectedPageId.value = pages.value[0]?.id ?? null
      await loadVersions()
    }
  }

  async function renameProject(name: string): Promise<void> {
    if (!project.value) return
    await projectRepo.updateFamily(project.value.familyId ?? project.value.id, { name })
    project.value.name = name
  }

  async function confirmPageReview(pageId: string): Promise<void> {
    const page = pageOf(pageId)
    if (!page?.reviewPending) return
    await pageRepo.update(pageId, { reviewPending: false })
    const current = pageOf(pageId)
    if (current) current.reviewPending = false
  }

  async function saveGlobalConstraint(
    item: GenerationConstraint,
    projectId: string,
  ): Promise<void> {
    if (project.value?.id !== projectId) throw new Error('项目已切换，请重新打开约束编辑')
    const sequence = loadSequence
    const items = await projectRepo.saveConstraint(projectId, plainClone(item))
    if (project.value?.id === projectId && sequence === loadSequence) {
      project.value.generationConstraints = items
      project.value.updatedAt = Date.now()
    }
  }

  async function removeGlobalConstraint(id: string, projectId: string): Promise<void> {
    if (project.value?.id !== projectId) throw new Error('项目已切换，请重新打开约束列表')
    const sequence = loadSequence
    const items = await projectRepo.removeConstraint(projectId, id)
    if (project.value?.id === projectId && sequence === loadSequence) {
      project.value.generationConstraints = items
      project.value.updatedAt = Date.now()
    }
  }

  return {
    project,
    pages,
    htmlByPage,
    streams,
    selectedPageId,
    selectedPage,
    selectedHtml,
    selectedStream,
    selectedChat,
    versions,
    loading,
    loadError,
    hierarchySaving,
    pageSearchQuery,
    exportSelectedPageIds,
    pageRows,
    movePage,
    refining,
    localEditingPageId,
    refineStream,
    progress,
    menuGroups,
    load,
    generatePages,
    regenerateSelected,
    retryFailed,
    cancelPage,
    cancelAll,
    selectPage,
    refineSelected,
    cancelRefine,
    rollbackTo,
    updateSelectedSpec,
    renamePage,
    copyPage,
    importPageHtml,
    createImportedPage,
    savePageAnnotations,
    addPage,
    removePage,
    confirmPageReview,
    renameProject,
    saveGlobalConstraint,
    removeGlobalConstraint,
  }
})

// Keep existing store instances in sync when actions are added during development.
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkbenchStore, import.meta.hot))
}
