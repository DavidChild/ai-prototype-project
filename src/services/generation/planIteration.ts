import { z } from 'zod'
import type { ChatMessage, ContentPart } from '@/types/llm'
import type { Page } from '@/types/page'
import type { Platform } from '@/types/project'
import type { ExtractedImage } from '@/types/parsing'
import type { ProviderConfig } from '@/types/provider'
import type {
  IterationEndpointContext,
  IterationPlan,
  IterationPlanChange,
  IterationRelatedPage,
} from '@/types/iteration'
import { blobToBase64 } from '@/utils/blob'
import { buildRepairPrompt } from '@/prompts/common'
import { createClient } from '../llm/factory'
import { LLMError } from '../llm/errors'
import { parseJsonLoose } from '../llm/jsonExtract'
import type { ChatOptions } from '../llm/types'
import type { IterationAiSession } from '@/types/iterationTask'

const rawSchema = z.object({
  productNature: z.string().catch(''),
  summary: z.string().catch(''),
  changes: z
    .array(
      z.object({
        action: z.enum(['update', 'create']),
        sourcePageId: z.string().optional().catch(undefined),
        parentSourcePageId: z.string().optional().catch(undefined),
        name: z.string().catch(''),
        description: z.string().catch(''),
        blocks: z.array(z.string()).catch([]),
        reason: z.string().catch(''),
        relatedPageIds: z.array(z.string()).catch([]),
      }),
    )
    .min(1, '迭代页面变更清单为空'),
})

export function normalizeIterationPlan(
  raw: z.infer<typeof rawSchema>,
  sourcePages: Pick<Page, 'id' | 'spec'>[],
  relatedPages: IterationRelatedPage[],
): IterationPlan {
  const sourceById = new Map(sourcePages.map((page) => [page.id, page]))
  const relatedIds = new Set(relatedPages.map((page) => page.pageId))
  const updated = new Set<string>()
  const changes: IterationPlanChange[] = []
  for (const item of raw.changes.slice(0, 40)) {
    const source = item.sourcePageId ? sourceById.get(item.sourcePageId) : undefined
    if (item.action === 'update') {
      if (!source || source.spec.groupOnly || updated.has(source.id)) continue
      updated.add(source.id)
    }
    const name = String(item.action === 'update' ? source!.spec.name : item.name ?? '').trim()
    if (!name) continue
    changes.push({
      action: item.action,
      sourcePageId: item.action === 'update' ? source!.id : undefined,
      parentSourcePageId:
        item.parentSourcePageId && sourceById.has(item.parentSourcePageId)
          ? item.parentSourcePageId
          : undefined,
      name: name.slice(0, 80),
      description: item.description.trim().slice(0, 1200),
      blocks: item.blocks.map((block) => block.trim()).filter(Boolean).slice(0, 16),
      reason: item.reason.trim().slice(0, 1200) || '根据本次版本需求进行初始迭代',
      relatedPageIds: [...new Set(item.relatedPageIds.filter((id) => relatedIds.has(id)))],
    })
  }
  if (!changes.length) throw new LLMError('parse', 'AI 没有返回可执行的页面变更')
  return {
    productNature: raw.productNature.trim().slice(0, 240) || '未明确的产品端',
    summary: raw.summary.trim().slice(0, 2000),
    changes,
  }
}

function parsePlan(
  text: string,
  sourcePages: Pick<Page, 'id' | 'spec'>[],
  relatedPages: IterationRelatedPage[],
): IterationPlan {
  const parsed = rawSchema.safeParse(parseJsonLoose(text))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new LLMError('parse', `版本规划结构不符合要求：${issue?.path.join('.')} ${issue?.message}`)
  }
  return normalizeIterationPlan(parsed.data, sourcePages, relatedPages)
}

function systemPrompt(platform: Platform): string {
  return `你是资深产品经理，负责规划已有原型项目的新迭代版本。当前目标端为${platform === 'pc' ? 'PC Web / 桌面端' : '移动端 H5 / App 式交互'}。

规划原则：
1. 优先采用用户维护的端性质和项目用途；没有填写或信息不足时，再根据项目名称、项目说明、目标用户、平台、布局和现有页面树判断当前端属于平台运营管理端、企业/B 端、消费者/C 端、PC Web、App、小程序、H5/WAP、Pad 或其他什么性质，并写入 productNature。不能只根据 pc/mobile 字段机械判断。
2. 完整阅读版本 PRD，结合当前端性质判断哪些需求适用于当前端。必须优先复用并修改旧版本已有的相关页面；只在旧版本确实没有承载新功能的合适页面时才创建新页面。
3. update 必须填写给定的 sourcePageId，不能靠页面名称猜测；不能更新纯导航分组。
4. create 仅用于业务迭代确实需要、且旧页面无法承载的缺失页面，可用 parentSourcePageId 放到已有菜单下。
5. 其他所选端的完整页面树只作跨端业务协同上下文。不要复制其端侧布局，也不能修改或改变其归属；仅在 relatedPageIds 中列出与当前变更直接相关的页面。
6. 不要把未被需求影响的旧页面列入 changes，不要制造重复页面，也不要遗漏 PRD 在当前端必需的业务闭环页面。
7. description 和 blocks 描述本次迭代后的页面目标；reason 说明基于旧页修改或新增的原因，以及它与当前端性质的关系。

只输出 JSON：
{"productNature":"例如：企业招聘 B 端 PC 管理后台","summary":"版本规划摘要","changes":[{"action":"update|create","sourcePageId":"update 时必填","parentSourcePageId":"create 时可选","name":"页面名","description":"迭代后页面用途","blocks":["可见区块"],"reason":"变更原因","relatedPageIds":["关联端页面 ID"]}]}`
}

function userPrompt(input: PlanIterationInput): string {
  return JSON.stringify({
    iterationRequirement: input.requirementText,
    sourceProject: {
      id: input.sourceProjectId,
      name: input.sourceProjectName,
      iteration: input.sourceIteration,
      platform: input.platform,
      productName: input.productName,
      overview: input.overview,
      targetUsers: input.targetUsers,
      layout: input.layout,
      declaredNature: input.declaredNature,
      purpose: input.purpose,
      pages: input.sourcePages.map((page) => ({
        sourcePageId: page.id,
        name: page.spec.name,
        parentSpecId: page.spec.parentId,
        groupOnly: !!page.spec.groupOnly,
        description: page.spec.description,
        blocks: page.spec.blocks,
      })),
    },
    synchronizedEndpoints: input.synchronizedEndpoints,
  })
}

export interface PlanIterationInput {
  provider: ProviderConfig
  model: string
  platform: Platform
  sourceProjectId: string
  sourceProjectName: string
  sourceIteration: string
  productName?: string
  overview?: string
  targetUsers?: string
  layout?: string
  declaredNature?: string
  purpose?: string
  sourcePages: Pick<Page, 'id' | 'spec'>[]
  requirementText: string
  synchronizedEndpoints: IterationEndpointContext[]
  session: IterationAiSession
  onSession?: (session: IterationAiSession) => void | Promise<void>
  images?: ExtractedImage[]
  signal?: AbortSignal
  onDelta?: ChatOptions['onDelta']
  onReasoningDelta?: ChatOptions['onReasoningDelta']
}

export async function planIterationRequirements(input: PlanIterationInput): Promise<IterationPlan> {
  const relatedPages = input.synchronizedEndpoints.flatMap((endpoint) => endpoint.pages)
  const client = createClient(input.provider)
  const text = userPrompt(input)
  const images = (input.images ?? []).slice(0, 8)
  let content: ChatMessage['content'] = text
  if (images.length) {
    const parts: ContentPart[] = [{ type: 'text', text }]
    for (const image of images)
      parts.push({ type: 'image', mimeType: image.mimeType, base64: await blobToBase64(image.blob) })
    content = parts
  }
  const session = input.session
  const system = session.system || systemPrompt(input.platform)
  const messages: ChatMessage[] = session.messages.length
    ? [
        ...session.messages,
        {
          role: 'user',
          content: '继续执行这个迭代规划任务。请结合前面的完整会话和当前任务状态，重新输出约定的完整 JSON 规划。',
        },
      ]
    : [{ role: 'user', content }]
  const saveSession = async (nextMessages: ChatMessage[]) => {
    session.system = system
    session.messages = nextMessages
    session.updatedAt = Date.now()
    await input.onSession?.(session)
  }
  await saveSession(messages)
  const request = {
    model: input.model,
    system,
    maxTokens: 6000,
    temperature: 0.2,
    jsonMode: true,
  }
  const callbacks: ChatOptions = {
    signal: input.signal,
    onDelta: input.onDelta,
    onReasoningDelta: input.onReasoningDelta,
  }
  let firstRaw = ''
  try {
    const result = await client.chat({ ...request, messages }, callbacks)
    firstRaw = result.text
    await saveSession([...messages, { role: 'assistant', content: firstRaw }])
    return parsePlan(firstRaw, input.sourcePages, relatedPages)
  } catch (error) {
    if (!(error instanceof LLMError) || error.kind !== 'parse' || input.signal?.aborted) throw error
    input.onDelta?.('\n\n[版本规划解析失败，正在请求模型修正…]\n\n')
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: firstRaw.slice(-2500) || '（空输出）' },
      { role: 'user', content: buildRepairPrompt(error.message) },
    ]
    await saveSession(repairMessages)
    const repaired = await client.chat(
      {
        ...request,
        messages: repairMessages,
      },
      callbacks,
    )
    await saveSession([...repairMessages, { role: 'assistant', content: repaired.text }])
    return parsePlan(repaired.text, input.sourcePages, relatedPages)
  }
}
