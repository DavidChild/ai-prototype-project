import { jsonrepair } from 'jsonrepair'
import type { QualityCheck, QualityCheckInput } from 'web-remarq'
import type { ProviderConfig } from '@/types/provider'
import { createClient } from '@/services/llm/factory'
import { formatStructuredAnnotation } from './generateAnnotations'

interface AnnotationQualityContext {
  provider: ProviderConfig
  model: string
  projectName: string
  pageName: string
  pageDescription?: string
  projectOverview?: string
  annotation: QualityCheckInput
  signal?: AbortSignal
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

export async function checkAnnotationQuality(
  input: AnnotationQualityContext,
): Promise<QualityCheck> {
  const result = await createClient(input.provider).chat(
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
  input: AnnotationQualityContext & { qualityCheck: QualityCheck },
): Promise<string> {
  const result = await createClient(input.provider).chat(
    {
      model: input.model,
      maxTokens: 1400,
      temperature: 0.2,
      jsonMode: true,
      system:
        '你是产品原型标注补充助手。根据已有标注及其质检问题，保留原标注中有效且有依据的信息，补充缺失的产品规则和说明。不要虚构权限、口径、接口、阈值或业务事实；无法确认的内容必须放入 pending。只返回 JSON：category、summary、rules 字符串数组、pending 字符串数组。分类清晰，每条规则只表达一个意思。',
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            projectName: input.projectName,
            projectOverview: input.projectOverview,
            pageName: input.pageName,
            pageDescription: input.pageDescription,
            selectedElement: input.annotation.fingerprint,
            originalComment: input.annotation.comment,
            qualityResult: {
              score: input.qualityCheck.score,
              issues: input.qualityCheck.issues,
              clarifyingQuestions: input.qualityCheck.clarifyingQuestions,
            },
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
  const comment = formatStructuredAnnotation(value)
  if (comment.length < 8) throw new Error('AI 返回的补充标注信息不足，请重试')
  return comment
}
