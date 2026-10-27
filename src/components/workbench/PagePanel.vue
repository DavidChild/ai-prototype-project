<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useDialog, useMessage, type TreeSelectOption } from 'naive-ui'
import { nanoid } from 'nanoid'
import type { Page, PageGenStatus } from '@/types/page'
import { useWorkbenchStore } from '@/stores/workbench'
import { useSettingsStore } from '@/stores/settings'
import PageTreeList from './PageTreeList.vue'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import { importProjectPackage } from '@/services/storage/projectPackage'
import { normalizeImage } from '@/services/parsing/imageOps'
import { imageToHtml } from '@/services/generation/imageToHtml'

const wb = useWorkbenchStore()
const auth = useAuthStore()
const settings = useSettingsStore()
const dialog = useDialog()
const message = useMessage()
const router = useRouter()
const projectPackageInput = ref<HTMLInputElement | null>(null)
const importingProject = ref(false)

type BatchImportStatus = 'pending' | 'reading' | 'generating' | 'saving' | 'done' | 'failed'
interface BatchImportItem {
  id: string
  file: File
  kind: 'html' | 'image'
  name: string
  status: BatchImportStatus
  error?: string
}

const batchShow = ref(false)
const batchFileInput = ref<HTMLInputElement | null>(null)
const batchItems = ref<BatchImportItem[]>([])
const batchParentId = ref('')
const batchImporting = ref(false)
let batchController: AbortController | null = null

const addShow = ref(false)
const addName = ref('')
const addParentId = ref<string>('')
const addGroupOnly = ref(false)
const expandedParentKeys = ref<Array<string | number>>([])

function requestRetryFailed() {
  const hasExistingHtml = wb.pages.some(
    (page) => page.genStatus === 'failed' && wb.htmlByPage.has(page.id),
  )
  if (!hasExistingHtml) {
    wb.retryFailed()
    return
  }
  dialog.warning({
    title: '确认重新生成失败页面',
    content: '部分失败页面已有可展示的 AI 原型内容，重试成功后会覆盖这些页面的当前内容，但不会删除页面配置和历史版本。是否继续？',
    positiveText: '继续生成',
    negativeText: '取消',
    onPositiveClick: () => wb.retryFailed(),
  })
}

const ROOT_PARENT_KEY = '__quickpage_root__'

const parentTreeOptions = computed<TreeSelectOption[]>(() => {
  const ids = new Set(wb.pages.map((page) => page.spec.id))
  const children = new Map<string, Page[]>()
  for (const page of wb.pages) {
    const parent =
      page.spec.parentId && ids.has(page.spec.parentId) ? page.spec.parentId : ROOT_PARENT_KEY
    const siblings = children.get(parent) ?? []
    siblings.push(page)
    children.set(parent, siblings)
  }
  const build = (page: Page, ancestors: Set<string>): TreeSelectOption => {
    const key = page.spec.id
    const nextAncestors = new Set(ancestors).add(key)
    const nested = (children.get(key) ?? [])
      .filter((child) => !nextAncestors.has(child.spec.id))
      .map((child) => build(child, nextAncestors))
    return {
      key,
      label: `${page.spec.groupOnly ? '导航分组' : '页面'} · ${page.spec.name}`,
      ...(nested.length ? { children: nested } : {}),
    }
  }
  return [
    {
      key: ROOT_PARENT_KEY,
      label: '一级菜单（项目根层级）',
      children: (children.get(ROOT_PARENT_KEY) ?? []).map((page) => build(page, new Set())),
    },
  ]
})

const selectedParentKey = computed({
  get: () => addParentId.value || ROOT_PARENT_KEY,
  set: (value: string | number | null) => {
    addParentId.value = value && value !== ROOT_PARENT_KEY ? String(value) : ''
  },
})

const selectedBatchParentKey = computed({
  get: () => batchParentId.value || ROOT_PARENT_KEY,
  set: (value: string | number | null) => {
    batchParentId.value = value && value !== ROOT_PARENT_KEY ? String(value) : ''
  },
})

const batchDoneCount = computed(
  () => batchItems.value.filter((item) => item.status === 'done').length,
)

function batchStatusLabel(status: BatchImportStatus): string {
  return {
    pending: '待导入',
    reading: '读取中',
    generating: 'AI 还原中',
    saving: '写入中',
    done: '已完成',
    failed: '失败',
  }[status]
}

function filePageName(filename: string): string {
  return filename.replace(/\.(?:html?|png|jpe?g|webp)$/i, '').trim() || '导入页面'
}

function openBatchImport() {
  batchItems.value = []
  batchParentId.value = ''
  batchShow.value = true
}

function closeBatchImport() {
  if (!batchImporting.value) batchShow.value = false
}

function readBatchFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  let rejected = 0
  const existing = new Set(
    batchItems.value.map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`),
  )
  for (const file of files) {
    if (batchItems.value.length >= 30) {
      rejected++
      continue
    }
    const signature = `${file.name}:${file.size}:${file.lastModified}`
    if (existing.has(signature)) continue
    const html = /\.html?$/i.test(file.name)
    const image = /\.(?:png|jpe?g|webp)$/i.test(file.name)
    if ((!html && !image) || (html && file.size > 5 * 1024 * 1024) || (image && file.size > 10 * 1024 * 1024)) {
      rejected++
      continue
    }
    existing.add(signature)
    batchItems.value.push({
      id: nanoid(),
      file,
      kind: html ? 'html' : 'image',
      name: filePageName(file.name),
      status: 'pending',
    })
  }
  if (rejected) message.warning(`有 ${rejected} 个文件格式不支持、超出大小限制或超过 30 个文件上限`)
}

function removeBatchItem(id: string) {
  if (batchImporting.value) return
  batchItems.value = batchItems.value.filter((item) => item.id !== id)
}

function validateImportedHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  if (!html.trim() || !/<[a-z][^>]*>/i.test(html) || !parsed.body.innerHTML.trim())
    throw new Error('文件中没有可导入的 HTML 页面内容')
  return html
}

async function originalImageSize(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  try {
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

async function runBatchImport() {
  const projectId = wb.project?.id
  const pending = batchItems.value.filter((item) => item.status !== 'done')
  if (!projectId || !pending.length || batchImporting.value) return
  if (pending.some((item) => !item.name.trim())) {
    message.warning('请补全所有页面名称')
    return
  }
  const resolved = pending.some((item) => item.kind === 'image')
    ? settings.resolveModel('generation', wb.project?.modelOverride)
    : undefined
  if (pending.some((item) => item.kind === 'image') && !resolved) {
    message.error('图片导入需要先配置支持图片输入的页面生成模型')
    return
  }
  const controller = new AbortController()
  batchController = controller
  batchImporting.value = true
  let imported = 0
  for (const item of pending) {
    if (controller.signal.aborted || wb.project?.id !== projectId) break
    item.error = undefined
    try {
      let html: string
      if (item.kind === 'html') {
        item.status = 'reading'
        html = validateImportedHtml(await item.file.text())
      } else {
        item.status = 'generating'
        const size = await originalImageSize(item.file)
        const normalized = await normalizeImage(item.file, 'upload')
        if (!normalized) throw new Error('图片无法读取或尺寸过小（至少 32 × 32）')
        html = await imageToHtml({
          ...resolved!,
          image: normalized.blob,
          name: item.name.trim(),
          instruction:
            '严格按照参考图内容和样式进行 1:1 高保真还原，不允许美化、简化、改写、增删或移动任何可见内容。保持原图尺寸比例、布局、间距、颜色、字体、文字、图标和视觉层级，所有元素使用可编辑 HTML/CSS 实现。',
          viewportWidth: size.width,
          viewportHeight: size.height,
          maxTokens: settings.genParams.maxTokens,
          signal: controller.signal,
        })
      }
      controller.signal.throwIfAborted()
      if (wb.project?.id !== projectId) throw new Error('项目已切换，已停止批量导入')
      item.status = 'saving'
      await wb.createImportedPage(item.name.trim(), html, batchParentId.value || undefined)
      item.status = 'done'
      imported++
    } catch (error) {
      item.status = 'failed'
      item.error = controller.signal.aborted
        ? '已停止，尚未导入'
        : error instanceof Error
          ? error.message
          : '导入失败'
    }
  }
  batchImporting.value = false
  batchController = null
  const failed = batchItems.value.filter((item) => item.status === 'failed').length
  if (controller.signal.aborted) {
    message.warning(`已停止批量导入，本次完成 ${imported} 个页面`)
  } else if (failed) {
    message.warning(`已导入 ${imported} 个页面，${failed} 个失败，可修正后重试`)
  } else {
    message.success(`已批量导入 ${imported} 个页面`)
    batchShow.value = false
  }
}

function stopBatchImport() {
  batchController?.abort()
}

onBeforeUnmount(() => batchController?.abort())
watch(
  () => wb.project?.id,
  () => {
    batchController?.abort()
    batchShow.value = false
  },
)

const selectedParentPath = computed(() => {
  if (!addParentId.value) return '项目根层级 › 一级菜单'
  const names: string[] = []
  const seen = new Set<string>()
  let current: string | undefined = addParentId.value
  while (current && !seen.has(current)) {
    seen.add(current)
    const page = wb.pages.find((item) => item.spec.id === current)
    if (!page) break
    names.unshift(page.spec.name)
    current = page.spec.parentId
  }
  return `项目根层级 › ${names.join(' › ')} › 新页面`
})

function parentBranchKeys(parentId: string): Array<string | number> {
  const keys: Array<string | number> = [ROOT_PARENT_KEY]
  const seen = new Set<string>()
  let current: string | undefined = parentId
  while (current && !seen.has(current)) {
    seen.add(current)
    keys.push(current)
    current = wb.pages.find((page) => page.spec.id === current)?.spec.parentId
  }
  return keys
}

const STATUS_META: Record<PageGenStatus, { label: string; color: string }> = {
  idle: { label: '未生成', color: 'rgba(127,127,127,0.45)' },
  queued: { label: '排队中', color: '#f59e0b' },
  generating: { label: '生成中', color: '#6366f1' },
  done: { label: '完成', color: '#22c55e' },
  failed: { label: '失败', color: '#ef4444' },
}

function childrenCount(page: Page): number {
  return wb.pages.filter((p) => p.spec.parentId === page.spec.id).length
}

function confirmRemove(page: Page) {
  if (wb.hierarchySaving || wb.loading) return
  if (childrenCount(page) > 0) {
    message.warning('该菜单下还有下级页面，请先删除或移动它们')
    return
  }
  let removing = false
  const confirmation = dialog.warning({
    title: page.spec.groupOnly ? '删除菜单确认' : '删除页面确认',
    content: `确定删除「${page.spec.name}」吗？${page.spec.groupOnly ? '该导航分组将被删除。' : '页面内容和全部版本历史将一并删除。'}此操作不可恢复。`,
    positiveText: '确认删除',
    negativeText: '取消',
    positiveButtonProps: { type: 'error' },
    maskClosable: false,
    onPositiveClick: async () => {
      if (removing) return false
      if (wb.project?.id !== page.projectId || !wb.pages.some((item) => item.id === page.id)) {
        message.error('项目或页面已切换，请重新选择要删除的页面')
        return false
      }
      removing = true
      confirmation.loading = true
      confirmation.closable = false
      confirmation.closeOnEsc = false
      confirmation.negativeButtonProps = { disabled: true }
      try {
        await wb.removePage(page.id)
        message.success('已删除「' + page.spec.name + '」')
        return true
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败，请重试')
        return false
      } finally {
        removing = false
        confirmation.loading = false
        confirmation.closable = true
        confirmation.closeOnEsc = true
        confirmation.negativeButtonProps = { disabled: false }
      }
    },
  })
}

function submitAdd() {
  const name = addName.value.trim()
  if (!name) return
  void wb.addPage(name, addParentId.value || undefined, addGroupOnly.value)
  addShow.value = false
  addName.value = ''
  addGroupOnly.value = false
}

function openAdd(parentId = '') {
  addParentId.value = parentId
  expandedParentKeys.value = parentBranchKeys(parentId)
  addGroupOnly.value = false
  addShow.value = true
}

function continueProjectGeneration() {
  if (!wb.project || wb.pages.length) return
  void router.push({ path: '/project/new', query: { initialize: wb.project.id } })
}

async function importPackage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const projectId = wb.project?.id
  if (!file || !projectId || wb.pages.length || importingProject.value) return
  importingProject.value = true
  try {
    await importProjectPackage(file, projectId)
    await wb.load(projectId)
    message.success('项目包已导入')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '项目包导入失败')
  } finally {
    importingProject.value = false
  }
}
</script>

<template>
  <div class="page-panel">
    <div v-if="auth.canEdit" class="panel-head">
      <n-progress
        type="line"
        :percentage="
          wb.progress.total ? Math.round((wb.progress.done / wb.progress.total) * 100) : 0
        "
        :show-indicator="false"
        :height="4"
      />
      <div class="head-row">
        <n-text depth="3" style="font-size: 12px">
          {{ wb.progress.done }}/{{ wb.progress.total }} 页完成
          <template v-if="wb.progress.active">· {{ wb.progress.active }} 进行中</template>
        </n-text>
        <n-space size="small">
          <n-button
            v-if="wb.progress.failed"
            size="tiny"
            type="warning"
            secondary
            @click="requestRetryFailed"
          >
            重试失败
          </n-button>
          <n-button v-if="wb.progress.active" size="tiny" secondary @click="wb.cancelAll()">
            全部停止
          </n-button>
          <n-tag
            v-else-if="wb.progress.total > 0 && wb.progress.done === wb.progress.total"
            size="small"
            type="success"
            :bordered="false"
          >
            全部完成
          </n-tag>
          <n-button
            v-else
            size="tiny"
            secondary
            type="primary"
            :disabled="!wb.progress.total"
            @click="
              wb.generatePages(
                wb.pages
                  .filter((p) => p.genStatus !== 'done' && !p.spec.groupOnly)
                  .map((p) => p.id),
              )
            "
          >
            生成未完成
          </n-button>
        </n-space>
      </div>
    </div>

    <n-scrollbar class="panel-body">
      <div v-if="auth.canEdit && !wb.pages.length && wb.project" class="empty-project-actions">
        <strong>初始化空项目</strong>
        <n-text depth="3">补充需求并由 AI 生成，或导入小豆原型项目包。</n-text>
        <n-button type="primary" block @click="continueProjectGeneration">一键生成项目原型</n-button>
        <n-button block secondary :loading="importingProject" @click="projectPackageInput?.click()">导入项目包</n-button>
        <input ref="projectPackageInput" type="file" accept=".xdproto,application/x-xiaodou-prototype" hidden @change="importPackage" />
      </div>
      <PageTreeList v-else :status-meta="STATUS_META" @add="openAdd" @remove="confirmRemove" />
    </n-scrollbar>

    <div v-if="auth.canEdit" class="panel-foot">
      <div class="panel-foot-actions">
        <n-button size="small" dashed @click="openAdd()">+ 新增菜单/页面</n-button>
        <n-button size="small" dashed @click="openBatchImport">批量导入</n-button>
      </div>
    </div>

    <n-modal v-model:show="addShow" preset="card" title="新增菜单/页面" style="width: 440px">
      <n-form label-placement="left" label-width="64" size="small">
        <n-form-item label="名称">
          <n-input v-model:value="addName" placeholder="如：会员中心" @keyup.enter="submitAdd" />
        </n-form-item>
        <n-form-item label="创建位置">
          <div class="parent-picker">
            <n-tree-select
              v-model:value="selectedParentKey"
              v-model:expanded-keys="expandedParentKeys"
              :options="parentTreeOptions"
              show-line
              show-path
              filterable
              separator=" › "
              placeholder="选择一级菜单或上级页面"
            />
            <n-text depth="3" class="parent-path">
              {{ selectedParentPath }}
            </n-text>
          </div>
        </n-form-item>
        <n-form-item v-if="!addParentId" label="类型">
          <n-checkbox v-model:checked="addGroupOnly">仅作导航分组，不生成页面</n-checkbox>
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="addShow = false">取消</n-button>
          <n-button type="primary" :disabled="!addName.trim()" @click="submitAdd">添加</n-button>
        </n-space>
      </template>
    </n-modal>

    <n-modal
      v-model:show="batchShow"
      preset="card"
      title="批量导入页面"
      style="width: 760px; max-width: 95vw"
      :mask-closable="!batchImporting"
      :closable="!batchImporting"
      :close-on-esc="!batchImporting"
    >
      <n-space vertical size="large">
        <n-alert type="info" :bordered="false">
          HTML 文件会直接创建为页面，不调用 AI；PNG、JPEG、WebP 图片会调用当前页面生成模型，严格按原图内容与样式进行 1:1 高保真还原。支持混合选择，单次最多 30 个文件。
        </n-alert>
        <n-form label-placement="left" label-width="76" size="small">
          <n-form-item label="导入位置">
            <n-tree-select
              v-model:value="selectedBatchParentKey"
              :options="parentTreeOptions"
              show-line
              show-path
              filterable
              separator=" › "
              :disabled="batchImporting"
              placeholder="选择一级菜单或上级页面"
            />
          </n-form-item>
          <n-form-item label="选择文件">
            <div class="batch-file-picker">
              <n-button secondary :disabled="batchImporting" @click="batchFileInput?.click()">
                选择 HTML 或图片
              </n-button>
              <n-text depth="3">HTML 最大 5 MB，图片最大 10 MB，可多选、可混选</n-text>
              <input
                ref="batchFileInput"
                type="file"
                multiple
                accept=".html,.htm,text/html,image/png,image/jpeg,image/webp"
                hidden
                @change="readBatchFiles"
              />
            </div>
          </n-form-item>
        </n-form>

        <div v-if="batchItems.length" class="batch-list">
          <div class="batch-list-head">
            <strong>待处理页面</strong>
            <span>{{ batchDoneCount }}/{{ batchItems.length }} 已完成</span>
          </div>
          <n-progress
            v-if="batchImporting || batchDoneCount"
            type="line"
            :percentage="Math.round((batchDoneCount / batchItems.length) * 100)"
            :show-indicator="false"
            :height="4"
          />
          <div v-for="item in batchItems" :key="item.id" class="batch-item">
            <n-tag size="small" :bordered="false" :type="item.kind === 'html' ? 'info' : 'warning'">
              {{ item.kind === 'html' ? 'HTML' : '图片' }}
            </n-tag>
            <div class="batch-item-main">
              <n-input
                v-model:value="item.name"
                size="small"
                placeholder="页面名称"
                :disabled="batchImporting || item.status === 'done'"
              />
              <span class="batch-filename" :title="item.file.name">{{ item.file.name }}</span>
              <span v-if="item.error" class="batch-error">{{ item.error }}</span>
            </div>
            <n-tag
              size="small"
              :bordered="false"
              :type="
                item.status === 'done'
                  ? 'success'
                  : item.status === 'failed'
                    ? 'error'
                    : item.status === 'pending'
                      ? 'default'
                      : 'info'
              "
            >
              {{ batchStatusLabel(item.status) }}
            </n-tag>
            <n-button
              quaternary
              size="tiny"
              title="移除"
              :disabled="batchImporting"
              @click="removeBatchItem(item.id)"
            >
              ×
            </n-button>
          </div>
        </div>
        <n-empty v-else size="small" description="请选择需要导入的 HTML 或页面截图" />
      </n-space>
      <template #footer>
        <div class="batch-footer">
          <n-text v-if="batchItems.some((item) => item.kind === 'image')" depth="3">
            图片还原会消耗当前渠道 Token
          </n-text>
          <n-space justify="end">
            <n-button v-if="batchImporting" type="warning" secondary @click="stopBatchImport">
              停止
            </n-button>
            <n-button :disabled="batchImporting" @click="closeBatchImport">取消</n-button>
            <n-button
              type="primary"
              :loading="batchImporting"
              :disabled="!batchItems.some((item) => item.status !== 'done')"
              @click="runBatchImport"
            >
              {{ batchItems.some((item) => item.status === 'failed') ? '重试失败项' : '开始批量导入' }}
            </n-button>
          </n-space>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.page-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.panel-head {
  padding: 12px 14px 8px;
}

.head-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  gap: 8px;
}

.panel-body {
  flex: 1;
}

.empty-project-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 24px 14px;
}

.empty-project-actions strong {
  font-size: 14px;
}

.empty-project-actions :deep(.n-text) {
  margin-bottom: 4px;
  font-size: 12px;
  line-height: 1.6;
}

.menu-group {
  padding: 4px 8px;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--qp-text-faint);
  padding: 6px 10px 2px;
  letter-spacing: 0.5px;
}

.page-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.child-item {
  padding-left: 26px;
}

.page-item:hover {
  background: var(--qp-hover);
}

.page-item.active {
  background: rgba(99, 102, 241, 0.16);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-spin {
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

.page-item:hover .item-actions,
.group-header:hover .item-actions {
  display: inline-flex;
}

.panel-foot {
  padding: 10px 14px;
  border-top: 1px solid var(--qp-border);
}

.panel-foot-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
}

.panel-foot-actions :deep(.n-button) {
  width: 100%;
}

.parent-picker {
  width: 100%;
  min-width: 0;
}

.parent-path {
  display: block;
  margin-top: 7px;
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.batch-file-picker {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.batch-list {
  max-height: 390px;
  overflow: auto;
  border: 1px solid var(--qp-border);
  border-radius: 6px;
}

.batch-list-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  background: var(--qp-panel, var(--n-color));
  border-bottom: 1px solid var(--qp-border);
  font-size: 12px;
}

.batch-list-head span,
.batch-filename {
  color: var(--qp-text-faint);
}

.batch-item {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr) auto 28px;
  align-items: start;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--qp-border);
}

.batch-item:last-child {
  border-bottom: 0;
}

.batch-item-main {
  min-width: 0;
}

.batch-filename,
.batch-error {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  overflow-wrap: anywhere;
}

.batch-error {
  color: #ef4444;
}

.batch-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

@media (max-width: 640px) {
  .panel-foot-actions,
  .batch-item {
    grid-template-columns: 1fr;
  }

  .batch-footer {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
