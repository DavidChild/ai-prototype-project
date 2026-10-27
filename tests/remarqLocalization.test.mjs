import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { adaptWebRemarqRuntime } from '../src/services/annotations/remarqLocalization.ts'

const original = await readFile(
  new URL('../node_modules/web-remarq/dist/web-remarq.global.js', import.meta.url),
  'utf8',
)

test('web-remarq toolbar, popup and shortcut help are localized', () => {
  const adapted = adaptWebRemarqRuntime(original)
  new Function(adapted)
  for (const text of [
    '选取元素',
    '查看元素间距',
    '快捷键帮助',
    '请输入原型标注说明',
    '复制全部标注到剪贴板',
    '退出元素选取 / 关闭弹窗',
    '标注弹窗中',
  ]) assert.ok(adapted.includes(text), `missing localized text: ${text}`)
  for (const text of [
    'Keyboard Shortcuts',
    'Toggle inspect mode',
    'Copy all annotations to clipboard',
    'Add your comment...',
    'Click to edit',
  ]) assert.ok(!adapted.includes(text), `found untranslated text: ${text}`)
})

test('unsupported web-remarq source fails explicitly', () => {
  assert.throws(() => adaptWebRemarqRuntime('unrecognised runtime'), /不兼容/)
})
