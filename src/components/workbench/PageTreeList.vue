<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { normalizeImage } from '@/services/parsing/imageOps'
import { imageToHtml } from '@/services/generation/imageToHtml'
import { useDialog, useMessage } from 'naive-ui'
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
const dialog = useDialog()
const importShow = ref(false)
const importTarget = ref<{ projectId: string; pageId: string; name: string } | null>(null)
const importHtml = ref('')
const importSaving = ref(false)
const importReading = ref(false)
const imageMode = ref(false)
const referenceImage = ref<Blob | null>(null)
const referenceUrl = ref('')
const imageInstruction = ref('')
const converting = ref(false)
const generatedChars = ref(0)
const currentSegment = ref(1)
const modelOutput = ref('')
const settings = useSettingsStore()
let imageController: AbortController | undefined
function clearReference() {
  if (referenceUrl.value) URL.revokeObjectURL(referenceUrl.value)
  referenceUrl.value = ''
  referenceImage.value = null
}
onBeforeUnmount(() => {
  imageController?.abort()
  clearReference()
})
watch(
  () => wb.project?.id,
  () => {
    imageController?.abort()
    importShow.value = false
  },
)
function openImport(page: Page, fromImage = false) {
  imageController?.abort()
  clearReference()
  imageMode.value = fromImage
  imageInstruction.value = ''
  modelOutput.value = ''
  importTarget.value = { projectId: page.projectId, pageId: page.id, name: page.spec.name }
  importHtml.value = ''
  importShow.value = true
}
async function readReference(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0]
  if (!file) return
  const target = importTarget.value
  importReading.value = true
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
      throw new Error('请选择 PNG、JPEG 或 WebP 图片')
    if (file.size > 10 * 1024 * 1024) throw new Error('参考图不能超过 10 MB')
    const image = await normalizeImage(file, 'upload')
    if (!image) throw new Error('图片无法读取或尺寸过小（至少 32 × 32）')
    if (target !== importTarget.value || !importShow.value) return
    clearReference()
    referenceImage.value = image.blob
    referenceUrl.value = URL.createObjectURL(image.blob)
    importHtml.value = ''
  } catch (error) {
    message.error(error instanceof Error ? error.message : '图片读取失败')
  } finally {
    importReading.value = false
    input.value = ''
  }
}
async function convertReference() {
  const target = importTarget.value,
    image = referenceImage.value
  if (!target || !image || converting.value) return
  const resolved = settings.resolveModel('generation', wb.project?.modelOverride)
  if (!resolved) {
    message.error('请先配置支持图片输入的页面生成模型')
    return
  }
  const controller = new AbortController()
  imageController = controller
  modelOutput.value = ''
  converting.value = true
  generatedChars.value = 0
  currentSegment.value = 1
  try {
    const html = await imageToHtml({
      ...resolved,
      image,
      name: target.name,
      instruction: imageInstruction.value,
      maxTokens: settings.genParams.maxTokens,
      signal: controller.signal,
      onDelta: (text) => {
        generatedChars.value += text.length
      },
      onOutput: (text) => {
        modelOutput.value = text
      },
      onSegment: (segment) => {
        currentSegment.value = segment
      },
    })
    if (
      !controller.signal.aborted &&
      importTarget.value === target &&
      importShow.value &&
      wb.project?.id === target.projectId
    ) {
      importHtml.value = html
      message.success('HTML 已生成，请检查后确认导入')
    }
  } catch (error) {
    if (!controller.signal.aborted)
      message.error(error instanceof Error ? error.message : '转换失败，请确认模型支持图片输入')
  } finally {
    if (imageController === controller) {
      converting.value = false
      imageController = undefined
    }
  }
}
async function readImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const target = importTarget.value
  if (!file || !target) return
  importReading.value = true
  try {
    if (!/\.html?$/i.test(file.name)) throw new Error('请选择 .html 或 .htm 文件')
    if (file.size > 5 * 1024 * 1024) throw new Error('HTML 文件不能超过 5 MB')
    const text = await file.text()
    if (importTarget.value === target && importShow.value) importHtml.value = text
  } catch (error) {
    message.error(error instanceof Error ? error.message : '文件读取失败')
  } finally {
    importReading.value = false
    input.value = ''
  }
}
async function confirmImport() {
  const target = importTarget.value
  if (!target || importSaving.value || importReading.value || converting.value) return
  importSaving.value = true
  try {
    const html = importHtml.value
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    if (!html.trim() || !/<[a-z][^>]*>/i.test(html) || !parsed.body.innerHTML.trim())
      throw new Error('请输入包含页面内容的 HTML')
    await wb.importPageHtml(target.projectId, target.pageId, html)
    importShow.value = false
    message.success('HTML 已导入，当前页面已初始化，可继续手动局部编辑')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '导入失败')
  } finally {
    importSaving.value = false
  }
}
const draggedId = ref<string | null>(null)
const over = ref<{ id: string; position: PageDropPosition } | null>(null)
const moveShow = ref(false)
const movingId = ref('')
const parentId = ref('')
const renameShow = ref(false)
const renameId = ref('')
const renameName = ref('')
const renameSaving = ref(false)
const copyShow = ref(false)
const copyTarget = ref<{ projectId: string; pageId: string } | null>(null)
const copyName = ref('')
const copySaving = ref(false)
const exportSelectionMode = ref(false)
watch(
  () => wb.project?.id,
  () => {
    copyShow.value = false
    copyTarget.value = null
    exportSelectionMode.value = false
  },
)
function openCopy(page: Page) {
  if (copySaving.value || wb.hierarchySaving || wb.loading) return
  copyTarget.value = { projectId: page.projectId, pageId: page.id }
  copyName.value = page.spec.name + 'copy'
  copyShow.value = true
}
async function confirmCopy() {
  const target = copyTarget.value
  if (!target || copySaving.value || !copyName.value.trim()) return
  copySaving.value = true
  try {
    await wb.copyPage(target.projectId, target.pageId, copyName.value)
    if (copyTarget.value === target && wb.project?.id === target.projectId) {
      searchQuery.value = ''
      copyShow.value = false
      message.success('页面已复制')
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : '复制失败，请重试')
  } finally {
    copySaving.value = false
  }
}
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
const searchQuery = computed({
  get: () => wb.pageSearchQuery,
  set: (value: string) => {
    wb.pageSearchQuery = value
  },
})
const searching = computed(() => !!searchQuery.value.trim())
const searchResult = computed(() => searchPageTreeRows(wb.pageRows, searchQuery.value))
const branchIds = computed(
  () => new Set(wb.pages.map((page) => page.spec.parentId).filter(Boolean)),
)
const visibleRows = computed(() =>
  searching.value ? searchResult.value.rows : visiblePageTreeRows(wb.pageRows, collapsed.value),
)
const validExportSelection = computed(() =>
  wb.exportSelectedPageIds.filter((id) => {
    const page = wb.pages.find((item) => item.id === id)
    return !!page && !page.spec.groupOnly && wb.htmlByPage.has(id)
  }),
)
const exportSelectionSet = computed(() => new Set(validExportSelection.value))
const selectionScope = computed(() =>
  wb.pageRows
    .map(({ page }) => page)
    .filter(
      (page) =>
        !page.spec.groupOnly &&
        wb.htmlByPage.has(page.id) &&
        (!searching.value || searchResult.value.matchedIds.has(page.spec.id)),
    ),
)
const wholeScopeSelected = computed(
  () =>
    !!selectionScope.value.length &&
    selectionScope.value.every((page) => exportSelectionSet.value.has(page.id)),
)
function setExportSelected(pageId: string, checked: boolean) {
  const next = new Set(validExportSelection.value)
  if (checked) next.add(pageId)
  else next.delete(pageId)
  wb.exportSelectedPageIds = [...next]
}
function toggleSelectionScope() {
  const scopeIds = new Set(selectionScope.value.map((page) => page.id))
  const next = new Set(validExportSelection.value)
  if (wholeScopeSelected.value) {
    for (const id of scopeIds) next.delete(id)
  } else {
    for (const id of scopeIds) next.add(id)
  }
  wb.exportSelectedPageIds = [...next]
}
function clearExportSelection() {
  wb.exportSelectedPageIds = []
}
function setExportSelectionMode(enabled: boolean) {
  exportSelectionMode.value = enabled
  if (!enabled) clearExportSelection()
}
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
  if (wb.hierarchySaving || (event.target as Element).closest('button, .n-checkbox')) {
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
async function confirmReview(page: Page) {
  try {
    await wb.confirmPageReview(page.id)
    message.success(`已确认「${page.spec.name}」的变更审阅`)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '确认审阅失败，请重试')
  }
}
function requestGenerate(page: Page) {
  if (!wb.htmlByPage.has(page.id)) {
    wb.generatePages([page.id])
    return
  }
  dialog.warning({
    title: '确认重新生成',
    content: '重新生成会覆盖当前页面现有的 AI 原型内容，但不会删除页面配置和历史版本。是否继续？',
    positiveText: '继续生成',
    negativeText: '取消',
    onPositiveClick: () => wb.generatePages([page.id]),
  })
}
function handlePageAction(page: Page, key: string) {
  switch (key) {
    case 'rename':
      return openRename(page)
    case 'copy':
      return openCopy(page)
    case 'remove':
      return emit('remove', page)
    case 'image-html':
      return openImport(page, true)
    case 'import':
      return openImport(page)
    case 'parent':
      return openMove(page)
    case 'add':
      return emit('add', page.spec.id)
    case 'up':
      return reorder(page, -1)
    case 'down':
      return reorder(page, 1)
    case 'confirm-review':
      return confirmReview(page)
  }
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
  <div class="export-selection-mode">
    <n-switch
      :value="exportSelectionMode"
      size="small"
      aria-label="开启导出页面多选"
      @update:value="setExportSelectionMode"
    />
    <span>导出选中</span>
    <span v-if="exportSelectionMode" class="selection-count">
      已选 {{ validExportSelection.length }} 页
    </span>
  </div>
  <div v-if="exportSelectionMode" class="export-selection-controls">
    <button type="button" :disabled="!selectionScope.length" @click="toggleSelectionScope">
      {{
        wholeScopeSelected
          ? searching
            ? '取消搜索结果'
            : '取消全部'
          : searching
            ? '全选搜索结果'
            : '全选全部页面'
      }}
    </button>
    <button type="button" :disabled="!validExportSelection.length" @click="clearExportSelection">
      清空
    </button>
  </div>
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
      <n-checkbox
        v-if="exportSelectionMode && !page.spec.groupOnly"
        class="export-check"
        size="small"
        :checked="exportSelectionSet.has(page.id)"
        :disabled="!wb.htmlByPage.has(page.id)"
        :aria-label="`${exportSelectionSet.has(page.id) ? '取消选择' : '选择'}${page.spec.name}用于导出`"
        :title="wb.htmlByPage.has(page.id) ? '勾选用于批量导出' : '页面尚无可导出内容'"
        @click.stop
        @update:checked="(checked: boolean) => setExportSelected(page.id, checked)"
      />
      <span v-else-if="exportSelectionMode" class="export-check-spacer" />
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
        :class="{
          'search-match': searching && searchResult.matchedIds.has(page.spec.id),
          'review-pending': page.reviewPending,
        }"
        :title="page.reviewPending ? `${page.spec.name}（AI 变更待审阅）` : page.spec.name"
        >{{ page.spec.name }}</span
      >
      <span class="item-actions" @click.stop>
        <n-dropdown
          trigger="click"
          :options="[
            ...(page.reviewPending ? [{ label: '确认变更审阅', key: 'confirm-review' }] : []),
            { label: '重命名', key: 'rename' },
            {
              label: '复制页面',
              key: 'copy',
              disabled:
                !!page.spec.groupOnly ||
                wb.loading ||
                wb.refining ||
                ['queued', 'generating'].includes(page.genStatus),
            },
            { label: '删除页面', key: 'remove' },
            { label: '移到上级菜单 / 调整层级', key: 'parent' },
            { label: '上移（含下级）', key: 'up' },
            { label: '下移（含下级）', key: 'down' },
            { label: '新增下级页面', key: 'add' },
            {
              label: '图片转 HTML',
              key: 'image-html',
              disabled:
                !!page.spec.groupOnly ||
                !!page.currentVersionId ||
                ['queued', 'generating'].includes(page.genStatus),
            },
            {
              label: '导入 HTML',
              key: 'import',
              disabled:
                !!page.spec.groupOnly ||
                !!page.currentVersionId ||
                ['queued', 'generating'].includes(page.genStatus),
            },
          ]"
          @select="(key: string) => handlePageAction(page, key)"
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
          @click="requestGenerate(page)"
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
    v-model:show="importShow"
    preset="card"
    :title="imageMode ? '图片转 HTML 初始化页面' : '导入 HTML 初始化页面'"
    style="width: 720px; max-width: 95vw"
    :mask-closable="false"
    :closable="!importSaving && !importReading && !converting"
    :close-on-esc="!importSaving && !importReading && !converting"
  >
    <n-space vertical>
      <n-text>目标页面：{{ importTarget?.name }}</n-text>
      <n-alert type="warning" :bordered="false"
        >仅初始化当前项目版本中尚无内容的普通页面，不覆盖已有页面。请仅导入可信
        HTML，页面中的脚本会在原型预览中运行；本地相对路径图片和样式不会随文件上传，建议使用自包含
        HTML。</n-alert
      >
      <input
        v-if="!imageMode"
        type="file"
        accept=".html,.htm,text/html"
        :disabled="importSaving || importReading"
        aria-label="选择 HTML 文件"
        @change="readImportFile"
      />
      <n-text v-if="!imageMode" depth="3"
        >上传 UTF-8 HTML 文件，或粘贴 HTML 源码（最多 5 MB）。不会调用 AI。</n-text
      >
      <template v-if="imageMode">
        <n-alert type="info" :bordered="false"
          >图片转 HTML 会调用当前项目的页面生成服务商，消耗
          token；必须选择支持图片输入的视觉模型。点击“开始转换”会将参考图和补充要求发送至该服务商。结果为可编辑
          HTML，不是把截图铺成背景，无法保证像素级一致。</n-alert
        >
        <n-text depth="3"
          >当前模型：{{
            settings.resolveModel('generation', wb.project?.modelOverride)?.model ?? '尚未配置'
          }}。支持 PNG/JPEG/WebP（最多 10 MB），发送前会缩放到最长边 1280。</n-text
        >
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="选择参考图片"
          :disabled="converting || importSaving || importReading"
          @change="readReference"
        />
        <img
          v-if="referenceUrl"
          :src="referenceUrl"
          alt="参考图片预览"
          style="max-width: 100%; max-height: 240px; object-fit: contain"
        />
        <n-input
          v-model:value="imageInstruction"
          placeholder="补充要求（可选）：例如保留文字、适配手机屏幕"
          :disabled="converting || importSaving"
        />
        <n-space
          ><n-button
            type="primary"
            :loading="converting"
            :disabled="!referenceImage || importReading || importSaving || converting"
            @click="convertReference"
            >开始转换（调用 AI）</n-button
          ><n-button v-if="converting" @click="imageController?.abort()"
            >停止转换</n-button
          ></n-space
        >
        <n-text v-if="converting" depth="3"
          >正在流式输出第 {{ currentSegment }} 段，已接收 {{ generatedChars }} 字符；截断后最多续写
          4 段，每段均消耗 token。完成后才可导入。</n-text
        >
        <details v-if="modelOutput" :open="converting">
          <summary>模型原始回复（用于排查，未自动导入）</summary>
          <n-input :value="modelOutput" type="textarea" readonly :rows="8" />
        </details>
      </template>
      <n-input
        v-model:value="importHtml"
        type="textarea"
        placeholder="粘贴 HTML 源码"
        :rows="12"
        :disabled="importSaving || importReading || converting"
      />
    </n-space>
    <template #footer
      ><n-space justify="end"
        ><n-button
          :disabled="importSaving || importReading || converting"
          @click="importShow = false"
          >取消</n-button
        ><n-button
          type="primary"
          :loading="importSaving"
          :disabled="!importHtml.trim() || importReading || converting"
          @click="confirmImport"
          >确认导入</n-button
        ></n-space
      ></template
    >
  </n-modal>
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
  <n-modal
    v-model:show="copyShow"
    preset="card"
    title="复制页面"
    style="width: 400px; max-width: 95vw"
    :mask-closable="!copySaving"
    :close-on-esc="!copySaving"
    :closable="!copySaving"
  >
    <n-input
      v-model:value="copyName"
      autofocus
      placeholder="请输入新页面名称"
      aria-label="复制后的页面名称"
      :disabled="copySaving"
      @keydown.enter="!$event.isComposing && confirmCopy()"
    />
    <n-text depth="3" style="display: block; margin-top: 12px; font-size: 12px"
      >复制当前页面配置和已保存内容，副本与原页面同级；不包含下级页面及历史版本。</n-text
    >
    <template #footer>
      <n-space justify="end">
        <n-button :disabled="copySaving" @click="copyShow = false">取消</n-button>
        <n-button
          type="primary"
          :loading="copySaving"
          :disabled="copySaving || !copyName.trim() || wb.hierarchySaving"
          @click="confirmCopy"
          >创建页面</n-button
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
.export-selection-mode {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px 7px;
  font-size: 11px;
  color: var(--qp-text-muted);
}
.selection-count {
  margin-right: auto;
  margin-left: 2px;
  white-space: nowrap;
}
.export-selection-controls {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 0 14px 7px;
  font-size: 11px;
}
.export-selection-controls button {
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--qp-text-faint);
  cursor: pointer;
  font: inherit;
}
.export-selection-controls button:hover:not(:disabled) {
  color: #818cf8;
}
.export-selection-controls button:disabled {
  opacity: 0.45;
  cursor: default;
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
.export-check,
.export-check-spacer {
  width: 16px;
  flex: 0 0 16px;
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
.page-name.review-pending {
  color: #f59e0b;
  font-weight: 600;
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
