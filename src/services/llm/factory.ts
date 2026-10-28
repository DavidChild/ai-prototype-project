import type { ProviderConfig } from '@/types/provider'
import { LLMError } from './errors'
import { AnthropicClient } from './anthropicClient'
import { OpenAIClient } from './openaiClient'
import type { LLMClient } from './types'
import { storageRequest } from '@/services/storage/db'

export function createClient(provider: ProviderConfig): LLMClient {
  const client = provider.protocol === 'anthropic'
    ? new AnthropicClient(provider)
    : new OpenAIClient(provider)
  return {
    listModels: () => client.listModels(),
    async chat(req, opts) {
      const result = await client.chat(req, opts)
      if (result.usage) {
        const match = location.pathname.match(/^\/project\/([^/]+)/)
        void storageRequest('usage.record', {
          projectId: match ? decodeURIComponent(match[1]!) : undefined,
          operation: 'llm.chat', provider: provider.protocol, model: req.model,
          inputTokens: result.usage.input, outputTokens: result.usage.output,
          channelScope: provider.source ?? 'tenant',
          providerId: provider.id,
        }).catch(() => {})
      }
      return result
    },
  }
}

/** 连通性测试：模型列表成功不代表模型可生成，必须再发起一次最小对话请求。 */
export async function testProvider(provider: ProviderConfig): Promise<{ models: string[] }> {
  const client = createClient(provider)
  let models: string[] = []
  try {
    models = await client.listModels()
  } catch (e) {
    if (!(e instanceof LLMError) || e.kind !== 'bad_request') throw e
  }
  const model = provider.models[0] ?? models[0]
  if (!model) {
    throw new LLMError('bad_request', '未找到可测试的模型，请先手动填写一个模型名再测试')
  }
  try {
    await client.chat({ model, messages: [{ role: 'user', content: '仅回复 OK' }], maxTokens: 32 })
  } catch (e) {
    if (e instanceof LLMError && e.kind === 'server') {
      throw new LLMError(
        'server',
        `模型列表可读取，但模型 ${model} 无法完成对话：${e.message}。请更换可用模型后重试`,
        { status: e.status, cause: e },
      )
    }
    throw e
  }
  return { models }
}
