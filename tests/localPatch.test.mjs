import assert from 'node:assert/strict'
import test from 'node:test'
import { applyHtmlPatches } from '../src/services/generation/localPatch.ts'

test('local patch preserves unrelated HTML and scripts', () => {
  const html =
    '<main><h1>旧标题</h1><button onclick="run()">确定</button></main><script>function run(){}</script>'
  assert.equal(
    applyHtmlPatches(
      html,
      [{ before: '<h1>旧标题</h1>', after: '<h1>新标题</h1>' }],
      ['<h1>旧标题</h1>'],
    ),
    html.replace('旧标题', '新标题'),
  )
})
test('ambiguous, missing, out-of-scope and malformed patches are rejected', () => {
  assert.throws(() => applyHtmlPatches('aa', [{ before: 'a', after: 'b' }], ['a']), /不唯一/)
  assert.throws(() => applyHtmlPatches('a', [{ before: 'b', after: 'c' }], ['b']), /不存在/)
  assert.throws(() => applyHtmlPatches('ab', [{ before: 'b', after: 'c' }], ['a']), /超出/)
  assert.throws(() => applyHtmlPatches('a', [{ before: '', after: 'b' }], ['a']), /格式/)
  assert.throws(() => applyHtmlPatches('a', [], ['a']), /有效/)
})
