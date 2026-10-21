import assert from 'node:assert/strict'
import test from 'node:test'
import {
  movePageTree,
  pageTreeRows,
  pageSubtreeIds,
  visiblePageTreeRows,
  searchPageTreeRows,
} from '../src/utils/pageTree.ts'

test('search finds a deeply nested page and preserves its full ancestor path', () => {
  const result = searchPageTreeRows(pageTreeRows(fixture()), 'a11')
  assert.deepEqual(ids(result.rows.map(({ page }) => page)), ['A', 'A1', 'A11'])
  assert.deepEqual([...result.matchedIds], ['A11'])
  assert.deepEqual(
    result.rows.map(({ depth }) => depth),
    [0, 1, 2],
  )
})

test('name search supports Chinese substrings, ignores case and trims the query', () => {
  const rows = pageTreeRows([page('菜单'), page('授权确认', '菜单'), page('API Settings')])
  assert.deepEqual([...searchPageTreeRows(rows, ' 确认 ').matchedIds], ['授权确认'])
  assert.deepEqual([...searchPageTreeRows(rows, 'api').matchedIds], ['API Settings'])
})

test('search includes matching branches without unrelated siblings or descendants', () => {
  const result = searchPageTreeRows(pageTreeRows(fixture()), '1')
  assert.deepEqual(ids(result.rows.map(({ page }) => page)), ['A', 'A1', 'A11', 'B', 'B1'])
  assert.equal(result.matchedIds.size, 3)
  assert.deepEqual(
    ids(searchPageTreeRows(pageTreeRows(fixture()), 'A1').rows.map(({ page }) => page)),
    ['A', 'A1', 'A11'],
  )
})

test('no match returns an empty result; blank search restores the full tree', () => {
  const rows = pageTreeRows(fixture())
  assert.equal(searchPageTreeRows(rows, '不存在').rows.length, 0)
  assert.equal(searchPageTreeRows(rows, '  ').rows.length, rows.length)
})

test('search reveals folded matches without mutating the saved collapse state', () => {
  const rows = pageTreeRows(fixture())
  const collapsed = new Set(['A', 'A1'])
  assert.equal(searchPageTreeRows(rows, 'A11').rows.length, 3)
  assert.deepEqual(ids(visiblePageTreeRows(rows, collapsed).map(({ page }) => page)), [
    'A',
    'B',
    'B1',
    'C',
  ])
  assert.deepEqual([...collapsed], ['A', 'A1'])
})

test('folding a root hides all descendants without changing the tree', () => {
  const pages = fixture()
  assert.deepEqual(
    ids(visiblePageTreeRows(pageTreeRows(pages), new Set(['A'])).map(({ page }) => page)),
    ['A', 'B', 'B1', 'C'],
  )
  assert.equal(pages.length, 7)
})

test('nested folding survives parent collapse and re-expansion', () => {
  const rows = pageTreeRows(fixture())
  const collapsed = new Set(['A', 'A1'])
  assert.deepEqual(ids(visiblePageTreeRows(rows, collapsed).map(({ page }) => page)), [
    'A',
    'B',
    'B1',
    'C',
  ])
  collapsed.delete('A')
  assert.deepEqual(ids(visiblePageTreeRows(rows, collapsed).map(({ page }) => page)), [
    'A',
    'A1',
    'A2',
    'B',
    'B1',
    'C',
  ])
  assert.equal(visiblePageTreeRows(rows, new Set()).length, 7)
})

test('moving a folded subtree still moves all hidden descendants', () => {
  const moved = movePageTree(fixture(), 'page-A', 'page-B', 'after')
  assert.deepEqual(
    ids(visiblePageTreeRows(pageTreeRows(moved), new Set(['A', 'B'])).map(({ page }) => page)),
    ['B', 'A', 'C'],
  )
  assert.equal(moved.find((page) => page.id === 'page-A11').spec.parentId, 'A1')
})

function page(id, parentId, extra = {}) {
  return {
    id: `page-${id}`,
    projectId: 'project',
    spec: { id, parentId, name: id, description: '', blocks: [] },
    sortOrder: 0,
    genStatus: 'done',
    currentVersionId: `version-${id}`,
    ...extra,
  }
}
const fixture = () => [
  page('A'),
  page('A1', 'A'),
  page('A11', 'A1'),
  page('A2', 'A'),
  page('B'),
  page('B1', 'B'),
  page('C'),
]
const ids = (pages) => pages.map((p) => p.spec.id)

test('moving a root menu moves all levels of descendants together', () => {
  const original = fixture()
  const moved = movePageTree(original, 'page-A', 'page-B', 'after')
  assert.deepEqual(ids(moved), ['B', 'B1', 'A', 'A1', 'A11', 'A2', 'C'])
  assert.deepEqual(
    moved.map((p) => p.sortOrder),
    [0, 1, 2, 3, 4, 5, 6],
  )
  assert.deepEqual(ids(original), ['A', 'A1', 'A11', 'A2', 'B', 'B1', 'C'])
  assert.equal(moved.find((p) => p.id === 'page-A11').currentVersionId, 'version-A11')
})

test('nesting a menu preserves descendant relationships', () => {
  const moved = movePageTree(fixture(), 'page-A', 'page-B', 'inside')
  assert.deepEqual(ids(moved), ['B', 'B1', 'A', 'A1', 'A11', 'A2', 'C'])
  assert.equal(moved.find((p) => p.id === 'page-A').spec.parentId, 'B')
  assert.equal(moved.find((p) => p.id === 'page-A11').spec.parentId, 'A1')
  assert.deepEqual(
    pageTreeRows(moved).map(({ depth }) => depth),
    [0, 1, 1, 2, 3, 2, 0],
  )
})

test('a child subtree can move between menus, before and after siblings', () => {
  const moved = movePageTree(fixture(), 'page-A1', 'page-B1', 'before')
  assert.deepEqual(ids(moved), ['A', 'A2', 'B', 'A1', 'A11', 'B1', 'C'])
  assert.equal(moved.find((p) => p.id === 'page-A1').spec.parentId, 'B')
  const reordered = movePageTree(moved, 'page-A1', 'page-B1', 'after')
  assert.deepEqual(ids(reordered), ['A', 'A2', 'B', 'B1', 'A1', 'A11', 'C'])
})

test('promoting a child to the root carries its descendants', () => {
  const moved = movePageTree(fixture(), 'page-A1', null, 'inside')
  assert.deepEqual(ids(moved), ['A', 'A2', 'B', 'B1', 'C', 'A1', 'A11'])
  assert.equal(moved.find((p) => p.id === 'page-A1').spec.parentId, undefined)
})

test('self and descendant drops are rejected in all positions', () => {
  for (const target of ['page-A', 'page-A1', 'page-A11']) {
    for (const position of ['before', 'inside', 'after']) {
      assert.throws(() => movePageTree(fixture(), 'page-A', target, position), /自身|下级/)
    }
  }
})

test('orphaned and cyclic legacy data remains visible without infinite recursion', () => {
  const pages = [page('A', 'missing'), page('B', 'C'), page('C', 'B')]
  assert.equal(pageTreeRows(pages).length, 3)
  assert.equal(pageSubtreeIds(pages, 'page-B').size, 2)
})

test('navigation-only groups and distinct page/spec IDs move correctly', () => {
  const pages = [
    page('A', undefined, { spec: { ...page('A').spec, groupOnly: true } }),
    page('A1', 'A'),
    page('B'),
  ]
  const moved = movePageTree(pages, 'page-A', 'page-B', 'before')
  assert.deepEqual(ids(moved), ['A', 'A1', 'B'])
  assert.equal(moved[0].spec.groupOnly, true)
})

test('missing pages and cross-project moves fail without mutation', () => {
  assert.throws(() => movePageTree(fixture(), 'missing', 'page-B', 'inside'), /不存在/)
  assert.throws(
    () =>
      movePageTree(
        [page('A'), page('B', undefined, { projectId: 'other' })],
        'page-A',
        'page-B',
        'inside',
      ),
    /跨项目/,
  )
})
