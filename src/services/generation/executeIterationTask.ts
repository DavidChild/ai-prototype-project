import type { ExtractedImage } from '@/types/parsing'
import type { Project } from '@/types/project'
import type { ProviderConfig } from '@/types/provider'
import type { IterationEndpointContext, IterationRelatedPage } from '@/types/iteration'
import type { IterationTask, IterationTaskEndpoint } from '@/types/iterationTask'
import { base64ToBlob } from '@/utils/blob'
import { initializeIterationProject } from './initializeIteration'
import type { InitializeIterationPageEvent } from './initializeIteration'
import { planIterationRequirements } from './planIteration'
import { iterationTaskRepo, pageRepo, projectRepo } from '@/services/storage/repositories'
import { nanoid } from 'nanoid'

export interface ExecuteIterationTaskInput {
  task: IterationTask
  projects: Project[]
  getProvider: (id: string) => ProviderConfig | undefined
  maxTokens: number
  temperature: number
  tailwindCdnUrl: string
  concurrency: number
  signal?: AbortSignal
  onStage?: (stage: string) => void
  onLog?: (message: string, kind?: 'info' | 'output' | 'error') => void
  onSaved?: (task: IterationTask) => void
  onPageChange?: (event: IterationPageChangeEvent) => void
}

export interface IterationPageChangeEvent extends InitializeIterationPageEvent {
  endpointSourceProjectId: string
  targetProjectId: string
}

function relatedPage(project: Project, page: Awaited<ReturnType<typeof pageRepo.listByProject>>[number]): IterationRelatedPage {
  return {
    projectId: project.id,
    projectName: project.name,
    iteration: project.iteration ?? 'v1.0',
    platform: project.platform,
    pageId: page.id,
    pageName: page.spec.name,
    description: page.spec.description,
    blocks: page.spec.blocks,
  }
}

async function endpointContext(project: Project): Promise<IterationEndpointContext> {
  const pages = await pageRepo.listByProject(project.id)
  return {
    projectId: project.id,
    projectName: project.name,
    iteration: project.iteration ?? 'v1.0',
    platform: project.platform,
    productName: project.analysis?.productName,
    overview: project.analysis?.overview,
    targetUsers: project.analysis?.targetUsers,
    layout: project.styleSpec.layout,
    declaredNature: project.endpointProfile?.nature,
    purpose: project.endpointProfile?.purpose,
    pages: pages.filter((page) => !page.spec.groupOnly).map((page) => relatedPage(project, page)),
  }
}

function generationProvider(input: ExecuteIterationTaskInput, endpoint: IterationTaskEndpoint) {
  const provider = input.getProvider(endpoint.generationProviderId)
  if (!provider || (!provider.apiKey && !provider.managed))
    throw new Error(`${endpoint.projectName} 原页面生成模型通道已不可用，请恢复模型配置后继续任务`)
  return provider
}

export async function executeIterationTask(input: ExecuteIterationTaskInput): Promise<IterationTask> {
  let task = input.task
  let saveQueue: Promise<void> = Promise.resolve()
  const save = async () => {
    const persist = async () => {
      task.updatedAt = Date.now()
      const saved = await iterationTaskRepo.save(task)
      task.updatedAt = saved.updatedAt
      input.onSaved?.(saved)
    }
    const pending = saveQueue.then(persist, persist)
    saveQueue = pending
    await pending
  }
  task.status = 'running'
  task.error = undefined
  await save()

  const projects = await projectRepo.list()
  const sourceProjects = new Map<string, Project>()
  const contexts = new Map<string, IterationEndpointContext>()
  for (const endpoint of task.endpoints) {
    const project = projects.find((item) => item.id === endpoint.sourceProjectId)
    if (!project) {
      endpoint.status = 'failed'
      endpoint.error = `${endpoint.projectName} 的来源版本已不存在`
      continue
    }
    sourceProjects.set(endpoint.sourceProjectId, project)
    try {
      contexts.set(endpoint.sourceProjectId, await endpointContext(project))
    } catch (error) {
      endpoint.status = 'failed'
      endpoint.error = error instanceof Error ? error.message : '项目页面读取失败'
    }
  }
  await save()
  const images: ExtractedImage[] = task.images.map((image, index) => ({
    id: `iteration-task-${task.id}-${index}`,
    blob: base64ToBlob(image.base64, image.mimeType),
    mimeType: image.mimeType,
    origin: 'upload',
  }))

  const endpointsToPlan = task.endpoints.filter(
    (endpoint) =>
      endpoint.status !== 'completed' &&
      !endpoint.plan &&
      sourceProjects.has(endpoint.sourceProjectId) &&
      contexts.has(endpoint.sourceProjectId),
  )
  if (endpointsToPlan.length) {
    for (const endpoint of endpointsToPlan) {
      endpoint.status = 'planning'
      endpoint.error = undefined
    }
    input.onStage?.(`正在统一规划 ${endpointsToPlan.length} 个端的新增与修改页面…`)
    await save()
  }

  // Finish planning every endpoint before any target version or page generation starts.
  await Promise.all(task.endpoints.map(async (endpoint) => {
    input.signal?.throwIfAborted()
    if (endpoint.status === 'completed') return
    const source = sourceProjects.get(endpoint.sourceProjectId)
    if (!source || !contexts.has(source.id)) return
    if (!endpoint.plan) {
      try {
        const provider = input.getProvider(endpoint.aiSession.providerId)
        if (!provider || (!provider.apiKey && !provider.managed))
          throw new Error(`AI 会话 ${endpoint.aiSession.id} 的模型通道已不可用`)
        const sourcePages = await pageRepo.listByProject(source.id)
        const synchronizedEndpoints = [...contexts.values()].filter((context) => context.projectId !== source.id)
        input.onLog?.(`[${endpoint.projectName}] 续接 AI 会话 ${endpoint.aiSession.id}，开始分析端性质与页面变更`)
        endpoint.plan = await planIterationRequirements({
          provider, model: endpoint.aiSession.model, platform: source.platform,
          sourceProjectId: source.id, sourceProjectName: source.name,
          sourceIteration: source.iteration ?? 'v1.0', productName: source.analysis?.productName,
          overview: source.analysis?.overview, targetUsers: source.analysis?.targetUsers,
          layout: source.styleSpec.layout, declaredNature: source.endpointProfile?.nature,
          purpose: source.endpointProfile?.purpose, sourcePages,
          requirementText: task.requirementText, synchronizedEndpoints,
          session: endpoint.aiSession,
          onSession: async (session) => { endpoint.aiSession = session; await save() },
          onDelta: (text) => input.onLog?.(text, 'output'),
          onReasoningDelta: (text) => input.onLog?.(text, 'output'),
          images, signal: input.signal,
        })
        const relatedIds = new Set(endpoint.plan.changes.flatMap((change) => change.relatedPageIds))
        endpoint.relatedPages = synchronizedEndpoints.flatMap((context) => context.pages).filter((page) => relatedIds.has(page.pageId))
        endpoint.status = 'planned'
        input.onLog?.(`[${endpoint.projectName}] AI 规划完成：${endpoint.plan.summary}`)
        await save()
      } catch (error) {
        endpoint.status = 'failed'
        endpoint.error = error instanceof Error ? error.message : 'AI 规划失败'
        input.onLog?.(`[${endpoint.projectName}] 规划失败：${endpoint.error}`, 'error')
        await save()
      }
    }
  }))

  if (endpointsToPlan.length) {
    const summaries = endpointsToPlan
      .filter((endpoint) => endpoint.plan)
      .map((endpoint) => `${endpoint.projectName}：${endpoint.plan!.summary}`)
    if (summaries.length) {
      task.conversation ??= []
      task.conversation.push({
        id: nanoid(),
        role: 'assistant',
        content: `已重新规划 ${summaries.length} 个端：\n${summaries.join('\n')}`,
        createdAt: Date.now(),
      })
      await save()
    }
  }

  input.onStage?.('各端页面规划已完成，正在准备目标版本…')
  await save()

  for (const endpoint of task.endpoints) {
    input.signal?.throwIfAborted()
    if (endpoint.status === 'completed') continue
    const source = sourceProjects.get(endpoint.sourceProjectId)
    if (!source || !contexts.has(source.id) || !endpoint.plan) continue
    if (!endpoint.targetProjectId) {
      try {
        const latestProjects = await projectRepo.list()
        const existing = latestProjects.find((project) =>
          (project.familyId ?? project.id) === endpoint.sourceFamilyId &&
          (project.iteration ?? 'v1.0').toLowerCase() === endpoint.targetIteration.toLowerCase())
        const target = existing ?? await projectRepo.copyIteration(endpoint.sourceProjectId, endpoint.targetIteration, {
          text: task.requirementText, documents: task.documents,
          relatedPages: endpoint.relatedPages ?? [], plan: endpoint.plan,
        })
        endpoint.targetProjectId = target.id
        endpoint.status = 'created'
        endpoint.error = undefined
        input.onLog?.(`[${endpoint.projectName}] 已创建目标版本 ${endpoint.targetIteration}`)
        await save()
      } catch (error) {
        endpoint.status = 'failed'
        endpoint.error = error instanceof Error ? error.message : '目标版本创建失败'
        input.onLog?.(`[${endpoint.projectName}] 版本创建失败：${endpoint.error}`, 'error')
        await save()
        continue
      }
    }

    try {
      let target = (await projectRepo.list()).find((project) => project.id === endpoint.targetProjectId)
      if (!target) throw new Error('目标新版本已不存在')
      if (endpoint.planNeedsApply) {
        target = await projectRepo.applyIterationPlan(target.id, endpoint.sourceProjectId, {
          text: task.requirementText,
          documents: task.documents,
          relatedPages: endpoint.relatedPages ?? [],
          plan: endpoint.plan,
        })
        endpoint.planNeedsApply = false
        await save()
      }
      const provider = generationProvider(input, endpoint)
      endpoint.status = 'generating'
      endpoint.error = undefined
      endpoint.totalPages = endpoint.plan.changes.length
      input.onStage?.(`正在迭代 ${target.name} · ${target.iteration ?? '新版本'}…`)
      await save()
      const initialized = await initializeIterationProject({
        project: target, provider, model: endpoint.generationModel,
        maxTokens: input.maxTokens, temperature: input.temperature,
        tailwindCdnUrl: input.tailwindCdnUrl, concurrency: input.concurrency,
        signal: input.signal,
        onProgress(done, total, pageName) {
          input.onStage?.(`正在迭代 ${target.name}：${done}/${total}${pageName ? ` · ${pageName}` : ''}`)
        },
        onPageChange(event) {
          input.onPageChange?.({
            ...event,
            endpointSourceProjectId: endpoint.sourceProjectId,
            targetProjectId: target.id,
          })
        },
      })
      if (!initialized.total)
        throw new Error('新规划尚未映射到具体页面，未执行任何页面修改')
      endpoint.totalPages = initialized.total
      endpoint.completedPages = initialized.completed
      endpoint.status = initialized.failed.length ? 'failed' : 'completed'
      endpoint.error = initialized.failed.length
        ? initialized.failed.map((item) => `${item.pageName}：${item.error}`).join('\n')
        : undefined
      input.onLog?.(
        initialized.failed.length
          ? `[${endpoint.projectName}] 已保留成功页面，仍有 ${initialized.failed.length} 个页面失败`
          : `[${endpoint.projectName}] 全部页面迭代完成`,
        initialized.failed.length ? 'error' : 'info',
      )
    } catch (error) {
      endpoint.status = 'failed'
      endpoint.error = error instanceof Error ? error.message : '页面迭代失败'
      input.onLog?.(`[${endpoint.projectName}] 页面迭代失败：${endpoint.error}`, 'error')
    }
    await save()
  }

  const failedEndpoints = task.endpoints.filter((endpoint) => endpoint.status !== 'completed')
  task.status = failedEndpoints.length ? 'failed' : 'completed'
  task.error = failedEndpoints.length
    ? `${failedEndpoints.length} 个端仍有未完成内容；其他端的版本与页面已保留，可继续失败部分`
    : undefined
  await save()
  return task
}
