import assert from 'node:assert/strict'
import test from 'node:test'
import { createJiti } from 'jiti'
import { fileURLToPath } from 'node:url'
const jiti = createJiti(import.meta.url, {
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
})
const { imageToHtml, extractImageHtml, buildImageToHtmlSystemPrompt } = await jiti.import(
  '../src/services/generation/imageToHtml.ts',
)

test('1:1 screenshot prompt optionally maps only project colors and tone', () => {
  const exact = buildImageToHtmlSystemPrompt()
  assert.match(exact, /alignment, colors, borders/)
  assert.doesNotMatch(exact, /project tone/)

  const toned = buildImageToHtmlSystemPrompt({
    designSpec: '主色：#2563eb；浅色模式',
    prototypeStyle: { pageName: '首页', summary: '{"themeColors":{"primary":"#2563eb"}}' },
  })
  assert.match(toned, /Colors, light\/dark mode and contrast are the only exception/)
  assert.match(toned, /Do not apply project layout, spacing, typography, radius or component-shape rules/)
  assert.match(toned, /主色：#2563eb；浅色模式/)
  assert.match(toned, /existing-prototype-tone page="首页"/)
})

test('conversion accepts short fenced HTML and JSON wrappers but rejects prose or empty replies', () => {
  assert.equal(extractImageHtml('以下为页面：\n```html\n<div>页面</div>\n```'), '<div>页面</div>')
  assert.equal(extractImageHtml(JSON.stringify({ html: '<main>内容</main>' })), '<main>内容</main>')
  assert.throws(() => extractImageHtml(''), /空正文/)
  assert.throws(() => extractImageHtml('抱歉，无法识别图片'), /原始回复/)
  assert.throws(() => extractImageHtml('<think>thinking</think>'), /原始回复/)
})

test('screenshot conversion streams segmented output and stops unsafe restarts', async () => {
  const savedFetch = globalThis.fetch,
    savedReader = globalThis.FileReader
  let calls = 0,
    finish = 'stop'
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:image/png;base64,cGl4ZWw='
      this.onload()
    }
  }
  globalThis.fetch = async (url, options) => {
    calls++
    assert.equal(url, 'https://mock.invalid/v1/chat/completions')
    const request = JSON.parse(options.body)
    assert.equal(request.model, 'vision-model')
    assert.equal(request.max_tokens, input.maxTokens)
    assert.equal(request.messages[1].content[1].image_url.url, 'data:image/png;base64,cGl4ZWw=')
    assert.match(request.messages[0].content, /real semantic DOM/)
    let html =
      '<!doctype html><html><head><style>h1{color:red}</style></head><body><h1>原型</h1></body></html>'
    if (finish === 'segmented') {
      const continuation = request.messages.length > 2
      html = continuation ? '原型</h1></body></html>' : '<!doctype html><html><body><h1>'
      return new Response(
        'data: ' +
          JSON.stringify({
            choices: [
              { delta: { content: html }, finish_reason: continuation ? 'stop' : 'length' },
            ],
          }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    return new Response(
      'data: ' +
        JSON.stringify({ choices: [{ delta: { content: html }, finish_reason: finish }] }) +
        '\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  const input = {
    provider: { protocol: 'openai', baseUrl: 'https://mock.invalid/v1', apiKey: 'mock' },
    model: 'vision-model',
    image: new Blob(['pixel'], { type: 'image/png' }),
    name: '页面',
    instruction: '',
    maxTokens: 1000,
    signal: new AbortController().signal,
  }
  try {
    assert.match(await imageToHtml(input), /<h1>原型<\/h1>/)
    input.maxTokens = 16000
    assert.match(await imageToHtml(input), /<h1>原型<\/h1>/)
    finish = 'length'
    await assert.rejects(imageToHtml(input), /重新输出了整页/)
    assert.equal(calls, 4)
    finish = 'segmented'
    const segments = [],
      outputs = []
    const html = await imageToHtml({
      ...input,
      onSegment: (n) => segments.push(n),
      onOutput: (text) => outputs.push(text),
    })
    assert.deepEqual(segments, [1, 2])
    assert.equal(html, '<!doctype html><html><body><h1>原型</h1></body></html>')
    assert.equal(outputs.at(-1), html)
    assert.equal(calls, 6)
  } finally {
    globalThis.fetch = savedFetch
    globalThis.FileReader = savedReader
  }
})
