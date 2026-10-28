import { jsonrepair } from 'jsonrepair'
import type { QualityCheck, QualityCheckInput } from 'web-remarq'
import type { ChatRequest } from '@/types/llm'
import type { ProviderConfig } from '@/types/provider'
import type { Platform } from '@/types/project'
import { LLMError } from '@/services/llm/errors'
import { createClient } from '@/services/llm/factory'
import { QUALITY_CONFIRMATION_OPTIONS } from '@/services/annotations/qualityConfirmationOptions'

interface AnnotationQualityContext {
  provider: ProviderConfig
  model: string
  projectName: string
  pageName: string
  pageDescription?: string
  projectOverview?: string
  platform: Platform
  annotation: QualityCheckInput
  signal?: AbortSignal
}

function platformContext(platform: Platform): string {
  return platform === 'pc'
    ? '当前项目配置为 PC Web。结合页面布局、业务文案和视口继续判断是否更适合 PC 或 PAD；没有明确 PAD 证据时按 PC 处理。'
    : '当前项目配置为移动端 H5。结合页面业务、交互和文案继续判断属于 APP、小程序还是 WAP/H5；没有明确 APP 或小程序证据时按 WAP/H5 处理。'
}

function parseObject(text: string, message: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(jsonrepair(text.trim())) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
  } catch {
    // Use the domain-specific error below.
  }
  throw new Error(message)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 8)
        .map((entry) => entry.slice(0, 500))
    : []
}

function conciseStringList(value: unknown, limit: number, maxLength = 220): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) =>
          entry
            .trim()
            .replace(/^[\s\-–—•·*\d.)、]+/, '')
            .replace(/\s+/g, ' ')
            .slice(0, maxLength),
        )
        .filter(Boolean)
        .filter((entry, index, entries) => entries.indexOf(entry) === index)
        .slice(0, limit)
    : []
}

function splitPendingSection(comment: string): { body: string; pending: string[] } {
  const marker = comment.match(/(?:^|\n)待确认[：:]\s*/m)
  if (!marker || marker.index === undefined) return { body: comment.trim(), pending: [] }
  const pendingStart = marker.index + marker[0].length
  return {
    body: comment.slice(0, marker.index).trimEnd(),
    pending: comment
      .slice(pendingStart)
      .split(/\r?\n/)
      .map((item) => item.trim().replace(/^[\s\-–—•·*\d.)、]+/, ''))
      .filter(Boolean),
  }
}

function normalizedRule(value: string): string {
  return value.replace(/[\s，。；：、,.!?！？:;"'“”‘’（）()\[\]【】]/g, '').toLowerCase()
}

export function mergeAnnotationSupplement(
  originalComment: string,
  resolved: string[],
  pending: string[],
): string {
  const { body } = splitPendingSection(originalComment)
  const normalizedBody = normalizedRule(body)
  const uniqueResolved = resolved.filter((item) => {
    const normalized = normalizedRule(item)
    return normalized.length >= 4 && !normalizedBody.includes(normalized)
  })

  let merged = body
  if (uniqueResolved.length) {
    const existingRuleNumbers = Array.from(body.matchAll(/^\s*(\d+)[.)、]\s+/gm)).map(
      (match) => Number(match[1]),
    )
    const firstNumber = existingRuleNumbers.length ? Math.max(...existingRuleNumbers) + 1 : 1
    const heading = /(?:^|\n)规则[：:]\s*(?:\r?\n|$)/m.test(body)
      ? '\n'
      : '\n\n补充规则：\n'
    merged +=
      heading + uniqueResolved.map((item, index) => `${firstNumber + index}. ${item}`).join('\n')
  }
  if (pending.length) merged += `\n\n待确认：\n${pending.map((item) => `- ${item}`).join('\n')}`
  return merged.trim().slice(0, 2400)
}

async function chatWithReasoningRetry(
  provider: ProviderConfig,
  request: ChatRequest,
  options: { signal?: AbortSignal },
) {
  const client = createClient(provider)
  const expandedRequest = { ...request, maxTokens: Math.max(request.maxTokens, 9000) }
  try {
    const result = await client.chat(request, options)
    return result.finishReason === 'length'
      ? await client.chat(expandedRequest, options)
      : result
  } catch (error) {
    if (
      error instanceof LLMError &&
      error.kind === 'parse' &&
      /思考内容/.test(error.message) &&
      /length/.test(error.message)
    ) {
      return await client.chat(expandedRequest, options)
    }
    throw error
  }
}

export async function checkAnnotationQuality(
  input: AnnotationQualityContext,
): Promise<QualityCheck> {
  const result = await chatWithReasoningRetry(
    input.provider,
    {
      model: input.model,
      maxTokens: 1000,
      temperature: 0.2,
      jsonMode: true,
      system:
        '你是产品原型标注质检助手。检查用户对选中界面元素所写的标注是否清晰、可执行且包含界面本身看不出的业务信息。只返回 JSON：score 为 clear、ambiguous 或 unactionable；issues 和 clarifyingQuestions 为中文字符串数组。这里只做质检，不生成改写。不要虚构权限、口径、接口或业务规则。',
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            projectName: input.projectName,
            projectOverview: input.projectOverview,
            pageName: input.pageName,
            pageDescription: input.pageDescription,
            platformContext: platformContext(input.platform),
            selectedElement: input.annotation.fingerprint,
            comment: input.annotation.comment,
            route: input.annotation.route,
            viewport: input.annotation.viewport,
          }),
        },
      ],
    },
    { signal: input.signal },
  )
  if (result.finishReason === 'length') throw new Error('AI 标注建议被截断，请重试')
  const value = parseObject(result.text, 'AI 未返回有效的标注质检结果')
  const score = ['clear', 'ambiguous', 'unactionable'].includes(String(value.score))
    ? (value.score as QualityCheck['score'])
    : 'ambiguous'
  return {
    score,
    issues: stringList(value.issues),
    clarifyingQuestions: stringList(value.clarifyingQuestions),
    refinedBy: 'auto',
    timestamp: Date.now(),
  }
}

export async function supplementAnnotationFromQuality(
  input: AnnotationQualityContext & {
    qualityCheck: QualityCheck
    focusAreas?: string[]
    instruction?: string
  },
): Promise<string> {
  const selectedFocusAreas = QUALITY_CONFIRMATION_OPTIONS
    .filter((option) => input.focusAreas?.includes(option.value))
    .map((option) => `${option.label}：${option.prompt}`)
  const result = await chatWithReasoningRetry(
    input.provider,
    {
      model: input.model,
      maxTokens: 1800,
      temperature: 0.2,
      jsonMode: true,
      system: `你是资深产品经理，负责对已有原型标注做最小必要的增量补充，不得重写整份标注。

先结合项目业务、页面用途、选中元素、视口和 platformContext，判断当前设计实际适用的终端：APP、小程序、PC、PAD 或 WAP/H5。必须尊重项目已配置的平台范围；只有页面材料存在明确证据时，才能细分为 APP、小程序或 PAD。

只逐项处理 qualityResult.clarifyingQuestions 和确实影响可执行性的 issues。resolved 只写新增的确认结论，不得复述 originalComment 已有内容，不得重新输出分类、摘要、元素用途、可见文案、布局描述或常识性操作，不得为了完整而扩展无关规则。原元素本身已经能体现的信息一律省略。每个结论只表达一个必要规则，通常 1 至 3 条，单条尽量控制在 80 字以内。

selectedFocusAreas 只是用户明确要求复核的可选方向，只有与当前元素和待确认项直接相关时才补充，不能逐项机械生成。涉及空间容量时，只补当前元素实际需要的容量或超界规则；涉及高频请求时，只补当前交互确实会触发请求时的控制规则。用户的 additionalInstruction 优先级高于通用建议，但不得据此虚构接口或业务事实。

无法从上下文合理确认且涉及安全、合规、计费、权限或明确数值阈值的事项放入 pending，措辞必须是具体待确认问题。不要把已经解决的问题继续留在 pending。

只返回 JSON：resolved 字符串数组、pending 字符串数组。不要返回完整标注。`,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            projectName: input.projectName,
            projectOverview: input.projectOverview,
            pageName: input.pageName,
            pageDescription: input.pageDescription,
            platformContext: platformContext(input.platform),
            selectedElement: input.annotation.fingerprint,
            originalComment: input.annotation.comment,
            qualityResult: {
              score: input.qualityCheck.score,
              issues: input.qualityCheck.issues,
              clarifyingQuestions: input.qualityCheck.clarifyingQuestions,
            },
            selectedFocusAreas,
            additionalInstruction: input.instruction?.trim().slice(0, 800),
            route: input.annotation.route,
            viewport: input.annotation.viewport,
          }),
        },
      ],
    },
    { signal: input.signal },
  )
  if (result.finishReason === 'length') throw new Error('AI 补充标注输出被截断，请重试')
  const value = parseObject(result.text, 'AI 未返回有效的补充标注')
  const resolved = conciseStringList(value.resolved, 4)
  const pending = conciseStringList(value.pending, 3)
  if (!resolved.length && !pending.length) throw new Error('AI 未返回需要补充的有效规则')
  return mergeAnnotationSupplement(input.annotation.comment, resolved, pending)
}

function extractPendingItems(comment: string): string[] {
  return splitPendingSection(comment).pending.slice(0, 8)
}

export async function supplementGeneratedAnnotation(
  input: AnnotationQualityContext & {
    focusAreas?: string[]
    instruction?: string
  },
): Promise<string> {
  const pendingItems = extractPendingItems(input.annotation.comment)
  return await supplementAnnotationFromQuality({
    ...input,
    qualityCheck: {
      score: pendingItems.length ? 'ambiguous' : 'clear',
      issues: pendingItems.length
        ? ['当前 AI 标注草稿包含待确认事项，需要结合业务和终端补充为可执行规则。']
        : ['复核当前 AI 标注草稿，并补充仍缺少的关键执行规则。'],
      clarifyingQuestions: pendingItems,
      refinedBy: 'auto',
      timestamp: Date.now(),
    },
  })
}
