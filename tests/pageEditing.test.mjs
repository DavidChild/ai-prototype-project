import assert from 'node:assert/strict'
import test from 'node:test'
import { pageTypeLockReason } from '../src/utils/pageEditing.ts'

const page = (overrides = {}) => ({
  id: 'page',
  projectId: 'project',
  spec: { id: 'spec', name: '菜单', description: '', blocks: [] },
  sortOrder: 0,
  genStatus: 'idle',
  updatedAt: 0,
  ...overrides,
})

test('ungenerated pages and navigation groups can change type', () => {
  assert.equal(pageTypeLockReason(page()), '')
  assert.equal(pageTypeLockReason(page({ genStatus: 'failed' })), '')
  assert.equal(pageTypeLockReason(page({ spec: { ...page().spec, groupOnly: true } })), '')
})

test('generated pages lock their type regardless of latest generation status', () => {
  for (const genStatus of ['idle', 'failed', 'queued', 'generating', 'done']) {
    assert.match(pageTypeLockReason(page({ genStatus, currentVersionId: 'version' })), /已生成/)
  }
  assert.match(pageTypeLockReason(page({ genStatus: 'done' })), /已生成/)
  assert.match(pageTypeLockReason(page(), true), /已生成/)
})

test('queued and generating pages cannot change type until stopped', () => {
  for (const genStatus of ['queued', 'generating']) {
    assert.match(pageTypeLockReason(page({ genStatus })), /先停止生成/)
  }
})
