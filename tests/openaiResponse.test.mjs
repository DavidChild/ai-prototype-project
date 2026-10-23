import assert from 'node:assert/strict'
import test from 'node:test'
import { createJiti } from 'jiti'
import { fileURLToPath } from 'node:url'
const jiti = createJiti(import.meta.url, {
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
})
const { OpenAIClient } = await jiti.import('../src/services/llm/openaiClient.ts')

test('compatible providers support JSON, message SSE, text blocks and unterminated final lines', async () => {
  const previous = globalThis.fetch
  const client = new OpenAIClient({
    baseUrl: 'https://mock.invalid',
    apiKey: 'test',
    protocol: 'openai',
  })
  const request = { model: 'mock', maxTokens: 1000, messages: [] }
  try {
    for (const json of [true, false]) {
      const payload = {
        choices: [
          {
            message: { content: [{ type: 'text', text: '<html>ok</html>' }] },
            finish_reason: 'stop',
          },
        ],
      }
      globalThis.fetch = async () =>
        new Response(json ? JSON.stringify(payload) : 'data: ' + JSON.stringify(payload), {
          headers: { 'content-type': json ? 'application/json' : 'text/event-stream' },
        })
      assert.equal((await client.chat(request)).text, '<html>ok</html>')
    }
    for (const [message, expected] of [
      [{ content: null, reasoning_content: 'thinking' }, /只返回了思考/],
      [{ content: null, refusal: 'cannot view image' }, /拒绝处理/],
      [{ content: null }, /不含正文/],
    ]) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ choices: [{ message }] }), {
          headers: { 'content-type': 'application/json' },
        })
      await assert.rejects(client.chat(request), expected)
    }
  } finally {
    globalThis.fetch = previous
  }
})
