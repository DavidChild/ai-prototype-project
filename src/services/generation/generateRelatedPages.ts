import type { ChatMessage, ContentPart } from '@/types/llm'
import type { ExtractedImage } from '@/types/parsing'
import { buildPageSystemPrompt, buildPageUserPrompt } from '@/prompts/pageGeneration'
import { buildStyleFragment } from '@/prompts/stylePrompt'
import { parseJsonLoose } from '@/services/llm/jsonExtract'
import { LLMError } from '@/services/llm/errors'
import { createClient } from '@/services/llm/factory'
import { blobToBase64 } from '@/utils/blob'
import { normalizeHtml } from './normalizeHtml'
import type { GeneratePageInput } from './generatePage'

export interface RelatedPageChange {
  action: 'update' | 'create'
  pageId?: string
  name: string
  html: string
  reason: string
}

interface RelatedResponse {
  changes?: unknown
}

export async function generateRelatedPages(
  input: GeneratePageInput & {
    currentPageId: string
    currentHtml?: string
    feedback?: string
    images?: ExtractedImage[]
  },
): Promise<RelatedPageChange[]> {
  const client = createClient(input.provider)
  const styleFragment = buildStyleFragment(input.styleSpec, input.platform)
  const reference = input.page.referenceDesign
  if (
    reference &&
    (!['image/png', 'image/jpeg', 'image/webp'].includes(reference.mimeType) ||
      !reference.base64 ||
      reference.base64.length > Math.ceil((2 * 1024 * 1024) / 3) * 4)
  )
    throw new LLMError('bad_request', '页面参考图无效或过大，请重新上传参考图')

  const editableIds = (input.context.importedPages ?? [])
    .filter((page) => page.access === 'editable')
    .map((page) => page.pageId)
  const outputInstruction = `请判断完成本次业务设计实际需要变更哪些页面，并只返回以下 JSON 结构：
{"changes":[{"action":"update","pageId":"页面ID","name":"页面名称","reason":"变更原因","html":"完整HTML"},{"action":"create","name":"新增页面名称","reason":"新增原因","html":"完整HTML"}]}

规则：
1. update 仅允许使用当前页面 ID「${input.currentPageId}」或已授权引入页 ID：${editableIds.length ? editableIds.join('、') : '无'}。
2. 只读引入页和未列出的页面不得出现在 changes 中。
3. 如果当前页面无需变化，可以不返回当前页面；如果需要补充业务流程，可 create 新关联页。
4. 最多返回 4 项变更；没有必要的变更时返回 {"changes":[]}。
5. 每个 html 都必须是完整、自包含、符合项目风格的高保真 HTML。`
  const taskContext = input.currentHtml
    ? `【当前页面现有 HTML】
${input.currentHtml}

【本次修改要求】
${input.feedback || '结合页面配置补全当前页面和必要的关联业务流程。'}`
    : ''
  const text = [buildPageUserPrompt(input.page, input.context, outputInstruction), taskContext]
    .filter(Boolean)
    .join('\n\n')
  let content: ChatMessage['content'] = text
  const images = input.images ?? []
  if (reference || images.length) {
    const parts: ContentPart[] = [{ type: 'text', text }]
    if (reference)
      parts.push({ type: 'image', mimeType: reference.mimeType, base64: reference.base64 })
    for (const image of images)
      parts.push({
        type: 'image',
        mimeType: image.mimeType,
        base64: await blobToBase64(image.blob),
      })
    content = parts
  }
  const result = await client.chat(
    {
      model: input.model,
      system: buildPageSystemPrompt(
        styleFragment,
        input.platform,
        !!reference,
        input.page.constraints?.mode === 'custom' && !!input.page.constraints.items.length,
        'related-json',
      ),
      messages: [{ role: 'user', content }],
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      jsonMode: true,
    },
    {
      signal: input.signal,
      onDelta: input.onDelta,
      onReasoningDelta: input.onReasoningDelta,
    },
  )
  if (result.finishReason === 'length')
    throw new LLMError('bad_request', '关联页面输出被截断，请减少引入页或调大生成 maxTokens')

  const parsed = parseJsonLoose<RelatedResponse>(result.text)
  if (!Array.isArray(parsed.changes))
    throw new LLMError('bad_request', 'AI 未返回有效的页面变更清单')
  const changes: RelatedPageChange[] = []
  for (const raw of parsed.changes.slice(0, 4)) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (item.action !== 'update' && item.action !== 'create') continue
    if (typeof item.name !== 'string' || !item.name.trim()) continue
    if (typeof item.html !== 'string' || !item.html.trim()) continue
    const pageId = typeof item.pageId === 'string' ? item.pageId : undefined
    if (item.action === 'update' && !pageId) continue
    changes.push({
      action: item.action,
      pageId: item.action === 'update' ? pageId : undefined,
      name: item.name.trim().slice(0, 80),
      reason:
        typeof item.reason === 'string' && item.reason.trim()
          ? item.reason.trim().slice(0, 500)
          : 'AI 关联构建',
      html: normalizeHtml(item.html, {
        tokens: input.styleSpec.tokens,
        platform: input.platform,
        tailwindCdnUrl: input.tailwindCdnUrl,
      }),
    })
  }
  return changes
}
