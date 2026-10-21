<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import type { Page, PageGenStatus } from '@/types/page'
import { useWorkbenchStore } from '@/stores/workbench'
import {
  pageSubtreeIds,
  visiblePageTreeRows,
  searchPageTreeRows,
  type PageDropPosition,
} from '@/utils/pageTree'

defineProps<{ statusMeta: Record<PageGenStatus, { label: string; color: string }> }>()
const emit = defineEmits<{ add: [parentId: string]; remove: [page: Page] }>()
const wb = useWorkbenchStore()
const message = useMessage()
const draggedId = ref<string | null>(null)
const over = ref<{ id: string; position: PageDropPosition } | null>(null)
const moveShow = ref(false)
const movingId = ref('')
const parentId = ref('')
const renameShow = ref(false)
const renameId = ref('')
const renameName = ref('')
const renameSaving = ref(false)
function openRename(page: Page) {
  renameId.value = page.id
  renameName.value = page.spec.name
  renameShow.value = true
}
async function confirmRename() {
  if (renameSaving.value || !renameName.value.trim()) return
  renameSaving.value = true
  try {
    await wb.renamePage(renameId.value, renameName.value)
    renameShow.value = false
    message.success('名称已修改')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '重命名失败，请重试')
  } finally {
    renameSaving.value = false
  }
}
const collapsed = ref(new Set<string>())
const searchQuery = ref('')
const searching = computed(() => !!searchQuery.value.trim())
const searchResult = computed(() => searchPageTreeRows(wb.pageRows, searchQuery.value))
const branchIds = computed(
  () => new Set(wb.pages.map((page) => page.spec.parentId).filter(Boolean)),
)
const visibleRows = computed(() =>
  searching.value ? searchResult.value.rows : visiblePageTreeRows(wb.pageRows, collapsed.value),
)
watch(
  () => wb.project?.id,
  (id) => {
    searchQuery.value = ''
    try {
      const saved: unknown = id
        ? JSON.parse(localStorage.getItem(`quickpage:collapsed:${id}`) ?? '[]')
        : []
      collapsed.value = new Set(
        Array.isArray(saved)
          ? saved.filter((value): value is string => typeof value === 'string')
          : [],
      )
    } catch {
      collapsed.value = new Set()
    }
  },
  { immediate: true },
)
watch(
  collapsed,
  (ids) => {
    if (!wb.project?.id) return
    try {
      localStorage.setItem(`quickpage:collapsed:${wb.project.id}`, JSON.stringify([...ids]))
    } catch {
      /* Folding still works when storage is unavailable. */
    }
  },
  { flush: 'sync' },
)
function toggleBranch(specId: string) {
  const next = new Set(collapsed.value)
  if (next.has(specId)) next.delete(specId)
  else next.add(specId)
  collapsed.value = next
}
function collapseAll() {
  collapsed.value = new Set(
    wb.pages.filter((page) => branchIds.value.has(page.spec.id)).map((page) => page.spec.id),
  )
}
function revealBranch(specId: string) {
  const next = new Set(collapsed.value)
  const seen = new Set<string>()
  let current: string | undefined = specId
  while (current && !seen.has(current)) {
    seen.add(current)
    next.delete(current)
    current = wb.pages.find((page) => page.spec.id === current)?.spec.parentId
  }
  collapsed.value = next
}
watch(
  () => wb.selectedPageId,
  (id) => {
    const parent = wb.pages.find((page) => page.id === id)?.spec.parentId
    if (parent) revealBranch(parent)
  },
)
const parentOptions = computed(() => {
  const excluded = pageSubtreeIds(wb.pages, movingId.value)
  return [
    { label: '一级菜单（无上级）', value: '' },
    ...wb.pageRows
      .filter(({ page }) => !excluded.has(page.spec.id))
      .map(({ page, depth }) => ({
        label: `${'　'.repeat(depth)}${page.spec.name}`,
        value: page.id,
      })),
  ]
})

function resetDrag() {
  draggedId.value = null
  over.value = null
}
function startDrag(event: DragEvent, page: Page) {
  if (wb.hierarchySaving || (event.target as Element).closest('button')) {
    event.preventDefault()
    return
  }
  draggedId.value = page.id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', page.id)
  }
}
function dragOver(event: DragEvent, page: Page) {
  if (!draggedId.value || pageSubtreeIds(wb.pages, draggedId.value).has(page.spec.id)) {
    over.value = null
    return
  }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = (event.clientY - rect.top) / rect.height
  over.value = {
    id: page.id,
    position: ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside',
  }
}
async function move(id: string, target: string | null, position: PageDropPosition) {
  try {
    await wb.movePage(id, target, position)
    if (position === 'inside' && target) {
      const parent = wb.pages.find((page) => page.id === target)
      if (parent) revealBranch(parent.spec.id)
    }
    message.success('页面层级已保存，下级页面随菜单一起移动')
    return true
  } catch (error) {
    message.error(error instanceof Error ? error.message : '移动失败，请重试')
    return false
  }
}
async function drop(event: DragEvent) {
  event.preventDefault()
  const id = draggedId.value
  const target = over.value
  resetDrag()
  if (id && target) await move(id, target.id, target.position)
}
function openMove(page: Page) {
  movingId.value = page.id
  parentId.value = wb.pages.find((p) => p.spec.id === page.spec.parentId)?.id ?? ''
  moveShow.value = true
}
async function confirmMove() {
  if (await move(movingId.value, parentId.value || null, 'inside')) moveShow.value = false
}
async function dropRoot() {
  const id = draggedId.value
  resetDrag()
  if (id) await move(id, null, 'inside')
}
async function reorder(page: Page, direction: number) {
  const siblings = wb.pageRows.filter(({ page: p }) => p.spec.parentId === page.spec.parentId)
  const index = siblings.findIndex(({ page: p }) => p.id === page.id)
  const target = siblings[index + direction]?.page
  if (target) await move(page.id, target.id, direction < 0 ? 'before' : 'after')
}
</script>

<template>
  <div class="tree-search">
    <n-input
      v-model:value="searchQuery"
      size="small"
      clearable
      placeholder="按页面名称搜索（含下级）"
      aria-label="按页面名称搜索"
      @keydown.esc="searchQuery = ''"
    />
    <div v-if="searching" class="search-summary" role="status" aria-live="polite">
      匹配 {{ searchResult.matchedIds.size }} 个页面 · 保留上级路径
    </div>
  </div>
  <div class="tree-hint">拖动调整 · 上下边缘排序 · 中间移入（含全部下级）</div>
  <div v-if="branchIds.size && !searching" class="tree-controls">
    <button type="button" @click="collapsed = new Set()">全部展开</button>
    <button type="button" @click="collapseAll">全部折叠</button>
  </div>
  <div class="page-tree" :aria-busy="wb.hierarchySaving">
    <div v-if="searching && !visibleRows.length" class="search-empty">
      没有匹配的页面，请换个名称试试
    </div>
    <div
      v-for="{ page, depth } in visibleRows"
      :key="page.id"
      class="tree-row"
      :class="{
        active: wb.selectedPageId === page.id,
        dragging: draggedId === page.id,
        'drop-before': over?.id === page.id && over.position === 'before',
        'drop-after': over?.id === page.id && over.position === 'after',
        'drop-inside': over?.id === page.id && over.position === 'inside',
      }"
      :style="{ paddingLeft: `${10 + depth * 16}px` }"
      :draggable="!wb.hierarchySaving"
      @dragstart="startDrag($event, page)"
      @dragend="resetDrag"
      @dragover.stop="dragOver($event, page)"
      @drop.stop="drop"
      @click="wb.selectPage(page.id)"
    >
      <span class="drag-handle" title="拖动页面（包含全部下级）">⠿</span>
      <button
        v-if="branchIds.has(page.spec.id)"
        type="button"
        class="branch-toggle"
        :aria-label="`${!searching && collapsed.has(page.spec.id) ? '展开' : '折叠'}${page.spec.name}的下级页面`"
        :aria-expanded="searching || !collapsed.has(page.spec.id)"
        :disabled="searching"
        :title="
          searching
            ? '搜索时自动展示匹配路径'
            : collapsed.has(page.spec.id)
              ? '展开下级'
              : '折叠下级'
        "
        :draggable="false"
        @click.stop="toggleBranch(page.spec.id)"
        @dragstart.stop.prevent
      >
        {{ !searching && collapsed.has(page.spec.id) ? '▸' : '▾' }}
      </button>
      <span v-else class="branch-spacer" />
      <n-spin v-if="page.genStatus === 'generating' && !page.spec.groupOnly" :size="10" />
      <span
        v-else
        class="status-dot"
        :style="{
          background: page.spec.groupOnly
            ? 'var(--qp-text-faint)'
            : statusMeta[page.genStatus].color,
        }"
        :title="page.spec.groupOnly ? '导航分组' : statusMeta[page.genStatus].label"
      />
      <span
        class="page-name"
        :class="{ 'search-match': searching && searchResult.matchedIds.has(page.spec.id) }"
        :title="page.spec.name"
        >{{ page.spec.name }}</span
      >
      <span class="item-actions" @click.stop>
        <n-dropdown
          trigger="click"
          :options="[
            { label: '重命名', key: 'rename' },
            { label: '移到上级菜单 / 调整层级', key: 'parent' },
            { label: '上移（含下级）', key: 'up' },
            { label: '下移（含下级）', key: 'down' },
            { label: '新增下级页面', key: 'add' },
          ]"
          @select="
            (key: string) =>
              key === 'rename'
                ? openRename(page)
                : key === 'parent'
                  ? openMove(page)
                  : key === 'add'
                    ? emit('add', page.spec.id)
                    : reorder(page, key === 'up' ? -1 : 1)
          "
        >
          <n-button size="tiny" quaternary title="更多操作" :disabled="wb.hierarchySaving"
            >⋮</n-button
          >
        </n-dropdown>
        <n-button
          v-if="!page.spec.groupOnly"
          size="tiny"
          quaternary
          title="重新生成"
          :disabled="page.genStatus === 'generating' || page.genStatus === 'queued'"
          @click="wb.generatePages([page.id])"
          >↻</n-button
        >
        <n-button
          size="tiny"
          quaternary
          type="error"
          title="删除"
          :disabled="wb.hierarchySaving"
          @click="emit('remove', page)"
          >✕</n-button
        >
      </span>
    </div>
    <div
      v-if="draggedId"
      class="root-drop"
      @dragover.prevent="over = null"
      @drop.prevent="dropRoot"
    >
      移到一级菜单末尾（包含全部下级）
    </div>
  </div>
  <n-modal
    v-model:show="renameShow"
    preset="card"
    title="重命名菜单 / 页面"
    style="width: 400px"
    :mask-closable="!renameSaving"
    :close-on-esc="!renameSaving"
    :closable="!renameSaving"
  >
    <n-input
      v-model:value="renameName"
      placeholder="请输入名称"
      aria-label="菜单或页面名称"
      :disabled="renameSaving"
      @keyup.enter="confirmRename"
    />
    <n-text depth="3" style="font-size: 12px">仅修改名称，不改变下级层级和已生成页面内容。</n-text>
    <template #footer>
      <n-space justify="end">
        <n-button :disabled="renameSaving" @click="renameShow = false">取消</n-button>
        <n-button
          type="primary"
          :loading="renameSaving"
          :disabled="!renameName.trim() || wb.hierarchySaving"
          @click="confirmRename"
          >保存</n-button
        >
      </n-space>
    </template>
  </n-modal>
  <n-modal v-model:show="moveShow" preset="card" title="调整页面层级" style="width: 420px">
    <n-text depth="3">移动时保留所有下级页面的层级关系；不会删除已生成内容。</n-text>
    <n-select v-model:value="parentId" :options="parentOptions" style="margin-top: 16px" />
    <template #footer
      ><n-space justify="end">
        <n-button @click="moveShow = false">取消</n-button>
        <n-button type="primary" :loading="wb.hierarchySaving" @click="confirmMove"
          >保存移动</n-button
        >
      </n-space></template
    >
  </n-modal>
</template>

<style scoped>
.tree-search {
  padding: 6px 14px 8px;
}
.search-summary {
  font-size: 11px;
  color: var(--qp-text-faint);
  margin-top: 6px;
}
.search-empty {
  padding: 20px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--qp-text-faint);
}
.page-name.search-match {
  color: #a5b4fc;
  font-weight: 600;
}
.branch-toggle:disabled {
  cursor: default;
}
.tree-hint {
  padding: 6px 14px 10px;
  font-size: 11px;
  color: var(--qp-text-faint);
}
.page-tree {
  padding: 0 8px 8px;
}
.tree-controls {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 0 14px 6px;
}
.tree-controls button,
.branch-toggle {
  border: 0;
  background: transparent;
  color: var(--qp-text-faint);
  cursor: pointer;
  font: inherit;
}
.tree-controls button {
  padding: 2px 0;
  font-size: 11px;
}
.branch-toggle,
.branch-spacer {
  width: 14px;
  flex: 0 0 14px;
}
.branch-toggle {
  padding: 0;
  line-height: 20px;
  font-size: 14px;
}
.branch-toggle:hover,
.tree-controls button:hover {
  color: #818cf8;
}
.branch-toggle:focus-visible,
.tree-controls button:focus-visible {
  outline: 1px solid #818cf8;
  border-radius: 3px;
}
.tree-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  min-height: 30px;
  box-sizing: border-box;
}
.tree-row:hover {
  background: var(--qp-hover);
}
.tree-row.active,
.tree-row.drop-inside {
  background: rgba(99, 102, 241, 0.16);
}
.tree-row.drop-inside {
  outline: 1px solid #818cf8;
}
.tree-row.dragging {
  opacity: 0.4;
}
.drop-before::before,
.drop-after::after {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  background: #818cf8;
  z-index: 1;
}
.drop-before::before {
  top: 0;
}
.drop-after::after {
  bottom: 0;
}
.drag-handle {
  cursor: grab;
  color: var(--qp-text-faint);
  font-size: 12px;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.page-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.item-actions {
  display: none;
  flex-shrink: 0;
}
.tree-row:hover .item-actions,
.tree-row.active .item-actions,
.tree-row:focus-within .item-actions {
  display: inline-flex;
}
.root-drop {
  padding: 14px 6px;
  margin-top: 8px;
  border: 1px dashed #818cf8;
  border-radius: 6px;
  text-align: center;
  font-size: 11px;
  color: #818cf8;
}
</style>
