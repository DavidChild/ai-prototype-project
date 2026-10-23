import type { ChatRequest, ChatResult, ContentPart, FinishReason } from '@/types/llm'
import type { ProviderConfig } from '@/types/provider'
import { classifyFetchError, errorFromResponse, LLMError } from './errors'
import { parseSSE } from './sse'
import { buildEndpoint, IDLE_TIMEOUT_MS, type ChatOptions, type LLMClient } from './types'

function toOpenAIContent(content: string | ContentPart[]): unknown {
  if (typeof content === 'string') return content
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image_url',
          image_url: { url: `data:${part.mimeType};base64,${part.base64}` },
        },
  )
}

interface StreamChunk {
  error?: { message?: string } | string
  choices?: {
    delta?: {
      content?: string | { type?: string; text?: string }[]
      reasoning_content?: string
      refusal?: string
    }
    message?: {
      content?: string | { type?: string; text?: string }[]
      refusal?: string
      reasoning_content?: string
    }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}
function contentText(content: string | { type?: string; text?: string }[] | undefined): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => !part.type || part.type === 'text' || part.type === 'output_text')
          .map((part) => part.text ?? '')
          .join('')
      : ''
}

function mapFinishReason(reason: string | null | undefined): FinishReason | null {
  if (!reason) return null
  if (reason === 'stop') return 'stop'
  if (reason === 'length') return 'length'
  return 'other'
}

export class OpenAIClient implements LLMClient {
  constructor(private provider: ProviderConfig) {}

  async chat(req: ChatRequest, opts: ChatOptions = {}): Promise<ChatResult> {
    try {
      return await this.doChat(req, !!req.jsonMode, opts)
    } catch (e) {
      // 部分兼容服务商不支持 response_format，去掉后重试一次
      if (req.jsonMode && e instanceof LLMError && e.kind === 'bad_request') {
        return this.doChat(req, false, opts)
      }
      throw e
    }
  }

  private async doChat(
    req: ChatRequest,
    jsonMode: boolean,
    opts: ChatOptions,
  ): Promise<ChatResult> {
    const messages: unknown[] = []
    if (req.system) messages.push({ role: 'system', content: req.system })
    for (const m of req.messages) {
      messages.push({ role: m.role, content: toOpenAIContent(m.content) })
    }
    const body = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: true,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }

    const timeoutCtl = new AbortController()
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutCtl.signal])
      : timeoutCtl.signal

    const endpoint = buildEndpoint(this.provider, '/chat/completions')
    let resp: Response
    try {
      resp = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.provider.apiKey}`,
          ...endpoint.headers,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (e) {
      throw classifyFetchError(e)
    }
    if (!resp.ok) throw await errorFromResponse(resp)

    let text = ''
    let finishReason: FinishReason = 'other'
    let usage: ChatResult['usage']
    let reasoningLength = 0
    let refusal = ''
    let events = 0
    const consume = (chunk: StreamChunk) => {
      events++
      if (chunk.error)
        throw new LLMError(
          'server',
          typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? '服务商返回错误'),
        )
      const choice = chunk.choices?.[0]
      const message = choice?.delta ?? choice?.message
      const content = contentText(message?.content)
      if (content) {
        text += content
        opts.onDelta?.(content)
      }
      const reasoning = message?.reasoning_content
      if (reasoning) {
        reasoningLength += reasoning.length
        opts.onReasoningDelta?.(reasoning)
      }
      refusal = message?.refusal || refusal
      const mapped = mapFinishReason(choice?.finish_reason)
      if (mapped) finishReason = mapped
      if (chunk.usage)
        usage = {
          input: chunk.usage.prompt_tokens ?? 0,
          output: chunk.usage.completion_tokens ?? 0,
        }
    }
    try {
      if (resp.headers.get('content-type')?.includes('application/json')) {
        consume((await resp.json()) as StreamChunk)
      } else {
        await parseSSE(
          resp,
          (ev) => {
            if (ev.data === '[DONE]') return
            let chunk: StreamChunk
            try {
              chunk = JSON.parse(ev.data) as StreamChunk
            } catch {
              return
            }
            consume(chunk)
          },
          { idleTimeoutMs: IDLE_TIMEOUT_MS },
        )
      }
    } catch (e) {
      throw classifyFetchError(e)
    }
    if (!text.trim()) {
      const detail = refusal
        ? '模型拒绝处理：' + refusal.slice(0, 240)
        : reasoningLength
          ? '模型只返回了思考内容，没有正文；请调整模型或输出 token 预算'
          : events
            ? '服务商响应不含正文 content，请检查模型和接口协议是否匹配'
            : '未解析到有效响应事件，请检查服务商是否返回标准 SSE 或 JSON'
      throw new LLMError('parse', detail + '（结束原因：' + finishReason + '；本次未保存）')
    }
    return { text, finishReason, usage }
  }

  async listModels(): Promise<string[]> {
    const endpoint = buildEndpoint(this.provider, '/models')
    let resp: Response
    try {
      resp = await fetch(endpoint.url, {
        headers: { authorization: `Bearer ${this.provider.apiKey}`, ...endpoint.headers },
      })
    } catch (e) {
      throw classifyFetchError(e)
    }
    if (!resp.ok) throw await errorFromResponse(resp)
    const json = (await resp.json()) as { data?: { id?: string }[] }
    return (json.data ?? [])
      .map((m) => m.id ?? '')
      .filter(Boolean)
      .sort()
  }
}
