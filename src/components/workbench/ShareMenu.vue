<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useWorkbenchStore } from '@/stores/workbench'
import { shareApi } from '@/services/sharing'
import type { PrototypeShareSummary, ShareAccess, ShareScope } from '@/types/share'
import type { Project } from '@/types/project'
import { searchPageTreeRows } from '@/utils/pageTree'

const props = withDefaults(defineProps<{
  project?: Pick<Project, 'id' | 'name' | 'iteration'>
  fixedScope?: ShareScope
  buttonSize?: 'tiny' | 'small'
  buttonQuaternary?: boolean
}>(), {
  project: undefined,
  fixedScope: undefined,
  buttonSize: 'small',
  buttonQuaternary: false,
})

const wb = useWorkbenchStore()
const dialog = useDialog()
const message = useMessage()
const show = ref(false)
const creating = ref(false)
const loadingList = ref(false)
const revokingId = ref('')
const access = ref<ShareAccess>('public')
const scope = ref<ShareScope>('single')
const includeAnnotations = ref(false)
const expiryHours = ref(24)
const createdLink = ref('')
const createdShare = ref<PrototypeShareSummary | null>(null)
const shares = ref<PrototypeShareSummary[]>([])
const activeProjectId = computed(() => props.project?.id ?? wb.project?.id ?? '')
const activeProjectName = computed(() => props.project?.name ?? wb.project?.name ?? '')
const activeIteration = computed(() => props.project?.iteration ?? wb.project?.iteration ?? 'v1.0')

const currentPageReady = computed(
  () => !!wb.selectedPage && !wb.selectedPage.spec.groupOnly && wb.htmlByPage.has(wb.selectedPage.id),
)
const selectedPageIds = computed(() => {
  const selected = new Set(wb.exportSelectedPageIds)
  return wb.pages
    .filter((page) => selected.has(page.id) && !page.spec.groupOnly && wb.htmlByPage.has(page.id))
    .map((page) => page.id)
})
const currentSearchPageIds = computed(() => {
  const query = wb.pageSearchQuery.trim()
  if (!query) return []
  const result = searchPageTreeRows(wb.pageRows, query)
  return wb.pageRows
    .map(({ page }) => page)
    .filter((page) => result.matchedIds.has(page.spec.id) && !page.spec.groupOnly && wb.htmlByPage.has(page.id))
    .map((page) => page.id)
})
const generatedPageCount = computed(
  () => wb.pages.filter((page) => !page.spec.groupOnly && wb.htmlByPage.has(page.id)).length,
)
const currentIterationPageCount = computed(() => {
  return wb.pages.filter((page) => !page.spec.groupOnly && wb.htmlByPage.has(page.id)).length
})
const scopeOptions = computed(() => [
  { label: `当前单页${currentPageReady.value ? ` · ${wb.selectedPage?.spec.name}` : ''}`, value: 'single', disabled: !currentPageReady.value },
  { label: `已选择页面 · ${selectedPageIds.value.length} 页`, value: 'selected', disabled: !selectedPageIds.value.length },
  {
    label: wb.pageSearchQuery.trim()
      ? `当前搜索框中的页面 · ${currentSearchPageIds.value.length} 页`
      : '当前搜索框中的页面 · 请先搜索',
    value: 'search',
    disabled: !wb.pageSearchQuery.trim() || !currentSearchPageIds.value.length,
  },
  {
    label: props.fixedScope === 'iteration'
      ? `当前版本号页面 · ${activeIteration.value}`
      : `当前版本号页面 · ${activeIteration.value} · ${currentIterationPageCount.value} 页`,
    value: 'iteration',
    disabled: props.fixedScope !== 'iteration' && !currentIterationPageCount.value,
  },
  { label: '整体项目 · 包含全部迭代版本', value: 'project', disabled: !generatedPageCount.value },
])
const visibleScopeOptions = computed(() => props.fixedScope
  ? scopeOptions.value.filter((option) => option.value === props.fixedScope).map((option) => ({ ...option, disabled: false }))
  : scopeOptions.value)
const expiryOptions = computed(() => [
  { label: '1 小时', value: 1 },
  { label: '24 小时', value: 24 },
  { label: '7 天', value: 24 * 7 },
  { label: '30 天', value: 24 * 30 },
  { label: '90 天', value: 24 * 90 },
  ...(access.value === 'tenant' ? [{ label: '永久分享', value: 0 }] : []),
])

function shareUrl(code: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/')
  return new URL(`${base}s/${code}`, window.location.origin).toString()
}

function scopeLabel(value: ShareScope): string {
  return { single: '单页', selected: '已选页面', search: '当前搜索', iteration: '当前版本号页面', project: '整体项目' }[value]
}

function accessLabel(value: ShareAccess): string {
  return { public: '公开', expiring: '公开', tenant: '租户成员' }[value]
}

function dateTime(value?: number): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '长期有效'
}

async function loadShares() {
  const projectId = activeProjectId.value
  if (!projectId) return
  loadingList.value = true
  try {
    shares.value = await shareApi.list(projectId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '分享记录加载失败')
  } finally {
    loadingList.value = false
  }
}

function openShare() {
  if (!activeProjectId.value) return
  createdLink.value = ''
  createdShare.value = null
  scope.value = props.fixedScope ?? (currentPageReady.value ? 'single' : 'iteration')
  show.value = true
  void loadShares()
}

async function writeClipboard(text: string, successText: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success(successText)
  } catch {
    message.error('复制失败，请手动复制')
  }
}

function copyLink(url: string) {
  return writeClipboard(url, '分享链接已复制')
}

function shareInformation(item: PrototypeShareSummary): string {
  const version = item.scope === 'project' ? '全部迭代版本' : activeIteration.value
  return [
    '小豆原型分享',
    `项目：${activeProjectName.value || item.title}`,
    `版本：${version}`,
    `范围：${scopeLabel(item.scope)}`,
    `访问：${accessLabel(item.access)}`,
    `标注：${item.includeAnnotations ? '带原型标注' : '不带原型标注'}`,
    `有效期：${item.expiresAt ? dateTime(item.expiresAt) : '长期有效'}`,
    `分享链接：${shareUrl(item.code)}`,
  ].join('\n')
}

function copyShareInformation(item: PrototypeShareSummary) {
  return writeClipboard(shareInformation(item), '分享信息已复制')
}

async function createShare() {
  const projectId = activeProjectId.value
  if (!projectId || creating.value) return
  const selectedScope = props.fixedScope ?? scope.value
  const pageIds = selectedScope === 'single'
    ? (wb.selectedPage ? [wb.selectedPage.id] : [])
    : selectedScope === 'selected'
      ? selectedPageIds.value
      : selectedScope === 'search'
        ? currentSearchPageIds.value
      : undefined
  creating.value = true
  try {
    const result = await shareApi.create({
      projectId,
      access: access.value,
      scope: selectedScope,
      includeAnnotations: includeAnnotations.value,
      pageIds,
      expiresAt: expiryHours.value > 0 ? Date.now() + expiryHours.value * 60 * 60 * 1000 : undefined,
    })
    createdShare.value = result
    createdLink.value = shareUrl(result.code)
    await loadShares()
    message.success('分享短链接已生成，请选择复制分享信息或仅复制链接')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '创建分享失败')
  } finally {
    creating.value = false
  }
}

function confirmRevoke(item: PrototypeShareSummary) {
  dialog.warning({
    title: '停用分享链接',
    content: '停用后，任何人都无法再通过这个短链接查看原型。该操作不会删除项目内容。',
    positiveText: '确认停用',
    negativeText: '取消',
    positiveButtonProps: { type: 'error' },
    onPositiveClick: async () => {
      const projectId = activeProjectId.value
      if (!projectId || revokingId.value) return false
      revokingId.value = item.id
      try {
        await shareApi.revoke(projectId, item.id)
        await loadShares()
        message.success('分享链接已停用')
        return true
      } catch (error) {
        message.error(error instanceof Error ? error.message : '停用失败')
        return false
      } finally {
        revokingId.value = ''
      }
    },
  })
}

watch(
  access,
  (value) => {
    if (value === 'public' && expiryHours.value === 0) expiryHours.value = 24
  },
)

watch(
  activeProjectId,
  () => {
    show.value = false
    shares.value = []
    createdLink.value = ''
    createdShare.value = null
  },
)
</script>

<template>
  <n-button
    :size="buttonSize"
    :secondary="!buttonQuaternary"
    :quaternary="buttonQuaternary"
    :disabled="!activeProjectId"
    @click="openShare"
  >分享</n-button>
  <n-modal
    v-model:show="show"
    preset="card"
    title="分享原型"
    style="width: 720px; max-width: 95vw"
    :mask-closable="!creating"
    :closable="!creating"
    :close-on-esc="!creating"
  >
    <n-space vertical size="large">
      <n-alert type="info" :bordered="false">
        <template v-if="(fixedScope ?? scope) === 'iteration'">
          分享锁定当前版本 {{ activeIteration }}，不锁定页面列表。该版本后续新增、删除或修改页面后，访问者刷新分享页即可读取最新内容。
        </template>
        <template v-else>
          分享内容与项目保持同步。页面内容、层级和标注更新后，访问者刷新分享页即可读取最新内容。
        </template>
      </n-alert>

      <n-form label-placement="left" label-width="88">
        <n-form-item label="分享范围">
          <n-select v-model:value="scope" :options="visibleScopeOptions" :disabled="!!fixedScope" />
        </n-form-item>
        <n-form-item label="访问方式">
          <n-radio-group v-model:value="access" name="share-access">
            <n-space>
              <n-radio value="public">公开分享</n-radio>
              <n-radio value="tenant">租户成员可见</n-radio>
            </n-space>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="分享时效">
          <div class="expiry-field">
            <n-select v-model:value="expiryHours" :options="expiryOptions" />
            <n-text v-if="expiryHours === 0" depth="3" class="permanent-hint">
              同一项目、范围、页面和标注设置只保留一个永久链接，重复创建会返回原链接。
            </n-text>
          </div>
        </n-form-item>
        <n-form-item label="原型标注">
          <n-switch v-model:value="includeAnnotations">
            <template #checked>带标注</template>
            <template #unchecked>不带标注</template>
          </n-switch>
        </n-form-item>
      </n-form>

      <div v-if="createdLink" class="created-link">
        <n-input :value="createdLink" readonly />
        <n-button v-if="createdShare" type="primary" @click="copyShareInformation(createdShare)">复制分享信息</n-button>
        <n-button @click="copyLink(createdLink)">仅复制链接</n-button>
        <n-button tag="a" :href="createdLink" target="_blank" secondary>打开</n-button>
      </div>

      <section class="share-history">
        <div class="share-history-head">
          <div>
            <strong>已有分享</strong>
            <span>{{ shares.length }} 条记录</span>
          </div>
          <n-button size="tiny" quaternary :loading="loadingList" @click="loadShares">刷新</n-button>
        </div>
        <n-empty v-if="!loadingList && !shares.length" size="small" description="当前项目还没有分享链接" />
        <n-spin v-else-if="loadingList && !shares.length" size="small" />
        <div v-else class="share-list">
          <div v-for="item in shares" :key="item.id" class="share-row">
            <div class="share-row-main">
              <div class="share-row-title">
                <strong>{{ scopeLabel(item.scope) }}</strong>
                <n-tag size="small" :bordered="false">{{ accessLabel(item.access) }}</n-tag>
                <n-tag v-if="item.includeAnnotations" size="small" type="info" :bordered="false">带标注</n-tag>
                <n-tag v-if="item.status === 'revoked'" size="small" type="error" :bordered="false">已停用</n-tag>
              </div>
              <div class="share-row-meta">
                <span><em>创建</em>{{ dateTime(item.createdAt) }}</span>
                <span><em>{{ item.expiresAt ? '到期' : '时效' }}</em>{{ item.expiresAt ? dateTime(item.expiresAt) : '永久有效' }}</span>
                <span><em>查看</em>{{ item.viewCount }} 次</span>
              </div>
            </div>
            <div class="share-row-actions">
              <n-button size="tiny" secondary :disabled="item.status !== 'active'" @click="copyShareInformation(item)">复制分享信息</n-button>
              <n-button size="tiny" secondary :disabled="item.status !== 'active'" @click="copyLink(shareUrl(item.code))">仅复制链接</n-button>
              <n-button size="tiny" tag="a" :href="shareUrl(item.code)" target="_blank" secondary :disabled="item.status !== 'active'">打开</n-button>
              <n-button size="tiny" type="error" quaternary :loading="revokingId === item.id" :disabled="item.status !== 'active'" @click="confirmRevoke(item)">停用</n-button>
            </div>
          </div>
        </div>
      </section>
    </n-space>
    <template #footer>
      <n-space justify="end">
        <n-button :disabled="creating" @click="show = false">关闭</n-button>
        <n-button type="primary" :loading="creating" @click="createShare">生成短链接</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.expiry-field {
  width: 100%;
}

.permanent-hint {
  display: block;
  margin-top: 7px;
  font-size: 12px;
}

.created-link {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  gap: 8px;
}

.share-history {
  border-top: 1px solid var(--qp-border);
  padding-top: 14px;
}

.share-history-head,
.share-row,
.share-row-title {
  display: flex;
  align-items: center;
}

.share-history-head,
.share-row {
  justify-content: space-between;
  gap: 12px;
}

.share-history-head > div {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.share-history-head span {
  color: var(--qp-text-faint);
  font-size: 12px;
}

.share-list {
  display: grid;
  gap: 8px;
  max-height: 240px;
  margin-top: 10px;
  overflow: auto;
}

.share-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  padding: 12px;
  border: 1px solid var(--qp-border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--qp-pane) 72%, transparent);
}

.share-row-main {
  min-width: 0;
}

.share-row-title {
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 5px;
}

.share-row-title strong {
  font-size: 13px;
}

.share-row-meta,
.share-row-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.share-row-meta {
  gap: 7px 14px;
  color: var(--qp-text-faint);
  font-size: 11px;
}

.share-row-meta span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.share-row-meta em {
  color: var(--qp-text-muted);
  font-style: normal;
  font-weight: 600;
}

.share-row-actions {
  justify-content: flex-end;
  gap: 6px;
  max-width: 260px;
}

@media (max-width: 640px) {
  .created-link,
  .share-row {
    grid-template-columns: 1fr;
  }

  .share-row {
    align-items: flex-start;
  }

  .share-row-actions {
    justify-content: flex-start;
    max-width: none;
  }
}
</style>
