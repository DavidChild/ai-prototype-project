import { computed, reactive, ref } from 'vue'
import { acceptHMRUpdate, defineStore } from 'pinia'
import { nanoid } from 'nanoid'
import type { PageSpec } from '@/types/analysis'
import type { Page, PageVersion } from '@/types/page'
import type { ExtractedImage } from '@/types/parsing'
import type { Project } from '@/types/project'
import { LLMError } from '@/services/llm/errors'
import { generatePageHtml } from '@/services/generation/generatePage'
import { refinePageHtml } from '@/services/generation/refinePage'
import { GenerationScheduler } from '@/services/generation/scheduler'
import { loadWorkbench, pageRepo, projectRepo, versionRepo } from '@/services/storage/repositories'
import { useSettingsStore } from './settings'
import { movePageTree, pageTreeRows, type PageDropPosition } from '@/utils/pageTree'
import { pageTypeLockReason } from '@/utils/pageEditing'

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
  const pageRows = computed(() => pageTreeRows(pages.value))

  const refining = ref(false)
  const refineStream = reactive<StreamState>({ text: '', reasoning: '' })
  const refineChats = reactive(new Map<string, RefineChatEntry[]>())
  let refineAbort: AbortController | null = null

  let scheduler: GenerationScheduler | null = null
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
      throw new LLMError('bad_request', '未配置「页面生成模型」，请先到设置页配置')
    }
    return resolved
  }

  function makeScheduler(): GenerationScheduler {
    const sequence = loadSequence
    return new GenerationScheduler({
      concurrency: () => settings.genParams.concurrency,
      generate: (page, signal, onDelta, onReasoningDelta) => {
        if (sequence !== loadSequence || signal.aborted)
          throw new DOMException('Aborted', 'AbortError')
        const resolved = resolveGenerationModel()
        const proj = project.value!
        const analysis = proj.analysis
        return generatePageHtml({
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
          },
          maxTokens: settings.genParams.maxTokens,
          temperature: settings.genParams.temperature,
          tailwindCdnUrl: settings.genParams.tailwindCdnUrl,
          signal,
          onDelta,
          onReasoningDelta,
        })
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
        onSuccess: async (pageId, html) => {
          if (sequence !== loadSequence || !pageOf(pageId)) return
          const version = await versionRepo.add(pageId, html, 'generate')
          if (sequence !== loadSequence) return
          htmlByPage.set(pageId, html)
          const page = pageOf(pageId)
          if (page) {
            page.genStatus = 'done'
            page.errorMessage = undefined
            page.currentVersionId = version.id
          }
          streams.delete(pageId)
          if (selectedPageId.value === pageId) void loadVersions()
        },
      },
    })
  }

  async function load(projectId: string, autostart = false): Promise<void> {
    scheduler?.cancelAll()
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

  function generatePages(pageIds: string[]): void {
    if (!scheduler) return
    const targets = pageIds
      .map((id) => pageOf(id))
      .filter((p): p is Page => !!p && !p.spec.groupOnly && !scheduler!.isActive(p.id))
    if (targets.length) scheduler.enqueue(targets)
  }

  function regenerateSelected(): void {
    if (selectedPageId.value) generatePages([selectedPageId.value])
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
    if (!page || !currentHtml || refining.value) return
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
      const html = await refinePageHtml({
        provider: resolved.provider,
        model: resolved.model,
        platform: proj.platform,
        styleSpec: proj.styleSpec,
        currentHtml,
        feedback,
        images,
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
    if (loading.value || !pageOf(version.pageId) || selectedPageId.value !== version.pageId) return
    const sequence = loadSequence
    const restored = await versionRepo.add(version.pageId, version.html, 'rollback')
    if (sequence !== loadSequence) return
    htmlByPage.set(version.pageId, version.html)
    const page = pageOf(version.pageId)
    if (page) {
      page.currentVersionId = restored.id
      page.genStatus = 'done'
    }
    await loadVersions()
  }

  async function renamePage(pageId: string, name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('页面名不能为空')
    if (hierarchySaving.value) throw new Error('正在保存页面层级，请稍候')
    const page = pageOf(pageId)
    if (!page) throw new Error('页面不存在，请刷新后重试')
    if (page.spec.name === trimmed) return
    await pageRepo.rename(pageId, trimmed)
    const current = pageOf(pageId)
    if (current) current.spec = { ...current.spec, name: trimmed }
    if (project.value?.id === page.projectId && project.value.analysis) {
      project.value.analysis.pages = project.value.analysis.pages.map((spec) =>
        spec.id === page.spec.id ? { ...spec, name: trimmed } : spec,
      )
    }
  }

  async function updateSelectedSpec(spec: PageSpec): Promise<void> {
    const page = selectedPage.value
    if (!page) return
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
    const current = pageOf(page.id)
    if (!current) return
    if (!!spec.groupOnly !== !!current.spec.groupOnly) {
      const reason = pageTypeLockReason(current, htmlByPage.has(current.id))
      if (reason) throw new Error(reason)
    }
    const savedSpec = plainClone({ ...spec, id: current.spec.id })
    await pageRepo.update(current.id, { spec: savedSpec })
    current.spec = savedSpec
  }

  /** 新增页面：parentSpecId 为空 = 一级菜单；groupOnly = 仅分组 */
  async function addPage(name: string, parentSpecId?: string, groupOnly = false): Promise<void> {
    const proj = project.value
    if (!proj) return
    if (hierarchySaving.value) throw new Error('正在保存页面层级，请稍候')
    const specId = nanoid()
    const page: Page = {
      id: specId,
      projectId: proj.id,
      spec: {
        id: specId,
        name,
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
    pageRows,
    movePage,
    refining,
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
    addPage,
    removePage,
    renameProject,
  }
})

// Keep existing store instances in sync when actions are added during development.
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorkbenchStore, import.meta.hot))
}
