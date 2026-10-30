<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDialog, useMessage } from 'naive-ui'
import {
  executeIterationTask,
  type IterationPageChangeEvent,
} from '@/services/generation/executeIterationTask'
import { iterationTaskRepo, loadWorkbench } from '@/services/storage/repositories'
import { useSettingsStore } from '@/stores/settings'
import type { Page } from '@/types/page'
import type { Project } from '@/types/project'
import type { IterationTask, IterationTaskEndpoint } from '@/types/iterationTask'
import { formatTime } from '@/utils/format'
import { nanoid } from 'nanoid'

type PageVisualStatus = 'pending' | 'generating' | 'completed' | 'failed'

interface EndpointSnapshot {
  project: Project
  pages: Page[]
  htmlByPage: Map<string, string>
}

interface PageChangeRow {
  key: string
  endpointId: string
  pageId?: string
  name: string
  action: 'update' | 'create'
  status: PageVisualStatus
  reason: string
  blocks: string[]
  depth: number
  error?: string
  html?: string
}

const route = useRoute()
const router = useRouter()
const settings = useSettingsStore()
const message = useMessage()
const dialog = useDialog()
const task = ref<IterationTask | null>(null)
const loading = ref(true)
const running = ref(false)
const stage = ref('')
const snapshots = ref<Record<string, EndpointSnapshot>>({})
const sourceSnapshots = ref<Record<string, EndpointSnapshot>>({})
const liveHtml = ref<Record<string, string>>({})
const expandedEndpointIds = ref<Set<string>>(new Set())
const selectedPageKey = ref('')
const previewRevision = ref(0)
const detailMode = ref<'change' | 'conversation'>(route.query.adjust === '1' ? 'conversation' : 'change')
const adjustmentText = ref('')
const adjustmentSaving = ref(false)
let controller: AbortController | null = null

const completedCount = computed(
  () => task.value?.endpoints.filter((endpoint) => endpoint.status === 'completed').length ?? 0,
)
const canRun = computed(
  () => !!task.value && !running.value && !['completed', 'cancelled'].includes(task.value.status),
)
const planningComplete = computed(
  () => task.value?.endpoints.every(
    (endpoint) => !!endpoint.plan || endpoint.status === 'failed' || endpoint.status === 'completed',
  ) ?? false,
)

function pageDepth(page: Page, pages: Page[]) {
  const bySpecId = new Map(pages.map((item) => [item.spec.id, item]))
  let depth = 0
  let parentId = page.spec.parentId
  const visited = new Set<string>()
  while (parentId && depth < 8 && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = bySpecId.get(parentId)
    if (!parent) break
    depth++
    parentId = parent.spec.parentId
  }
  return depth
}

function pageStatus(page: Page): PageVisualStatus {
  if (page.genStatus === 'generating') return 'generating'
  if (page.genStatus === 'failed') return 'failed'
  if (page.iterationInitialized) return 'completed'
  return 'pending'
}

function pageRows(endpoint: IterationTaskEndpoint): PageChangeRow[] {
  if (!planningComplete.value) return []
  const snapshot = snapshots.value[endpoint.sourceProjectId]
  if (snapshot) {
    return snapshot.pages
      .filter((page) => !page.spec.groupOnly && !!page.spec.iterationChange)
      .map((page) => {
        const key = `${endpoint.sourceProjectId}:${page.id}`
        return {
          key,
          endpointId: endpoint.sourceProjectId,
          pageId: page.id,
          name: page.spec.name,
          action: page.spec.iterationChange!.action,
          status: pageStatus(page),
          reason: page.spec.iterationChange!.reason,
          blocks: page.spec.blocks ?? [],
          depth: pageDepth(page, snapshot.pages),
          error: page.errorMessage,
          html: liveHtml.value[key] ?? snapshot.htmlByPage.get(page.id),
        }
      })
  }
  const sourceSnapshot = sourceSnapshots.value[endpoint.sourceProjectId]
  return (endpoint.plan?.changes ?? []).map((change, index) => ({
    key: `${endpoint.sourceProjectId}:plan:${change.sourcePageId ?? `${change.action}-${index}`}`,
    endpointId: endpoint.sourceProjectId,
    pageId: change.sourcePageId,
    name: change.name,
    action: change.action,
    status: endpoint.status === 'failed' ? 'failed' : 'pending',
    reason: change.reason,
    blocks: change.blocks,
    depth: (() => {
      if (!sourceSnapshot) return 0
      const anchorId = change.action === 'update' ? change.sourcePageId : change.parentSourcePageId
      const anchor = sourceSnapshot.pages.find((page) => page.id === anchorId)
      return anchor ? pageDepth(anchor, sourceSnapshot.pages) + (change.action === 'create' ? 1 : 0) : 0
    })(),
    error: endpoint.status === 'failed' ? endpoint.error : undefined,
    html: change.action === 'update' && sourceSnapshot && change.sourcePageId
      ? sourceSnapshot.htmlByPage.get(change.sourcePageId)
      : undefined,
  }))
}

const allPageRows = computed(() =>
  task.value?.endpoints.flatMap((endpoint) => pageRows(endpoint)) ?? [],
)
const selectedPage = computed(
  () => allPageRows.value.find((row) => row.key === selectedPageKey.value) ?? null,
)
const selectedEndpoint = computed(() => {
  const endpointId = selectedPage.value?.endpointId
  return task.value?.endpoints.find((endpoint) => endpoint.sourceProjectId === endpointId)
    ?? task.value?.endpoints[0]
    ?? null
})
const previewHtml = computed(() => selectedPage.value?.html ?? '')
const previewKey = computed(
  () => `${selectedPage.value?.key ?? 'empty'}-${previewRevision.value}`,
)

function endpointStatusText(endpoint: IterationTaskEndpoint) {
  return {
    pending: '等待',
    planning: '规划中',
    planned: '已规划',
    created: '版本已创建',
    generating: '迭代中',
    failed: '部分失败',
    completed: '已完成',
  }[endpoint.status]
}

function pageStatusText(status: PageVisualStatus) {
  return { pending: '等待', generating: '生成中', completed: '已完成', failed: '失败' }[status]
}

function endpointProgress(endpoint: IterationTaskEndpoint) {
  const rows = pageRows(endpoint)
  return {
    done: rows.filter((row) => row.status === 'completed').length,
    total: rows.length || endpoint.totalPages || 0,
  }
}

function ensureSelection(preferredEndpointId?: string) {
  if (selectedPage.value) return
  const rows = allPageRows.value
  const preferred = preferredEndpointId
    ? rows.find((row) => row.endpointId === preferredEndpointId && row.status === 'generating')
      ?? rows.find((row) => row.endpointId === preferredEndpointId)
    : undefined
  const next = preferred
    ?? rows.find((row) => row.status === 'generating')
    ?? rows.find((row) => row.status === 'failed')
    ?? rows[0]
  selectedPageKey.value = next?.key ?? ''
}

async function refreshEndpoint(endpointId: string, preferredPageId?: string) {
  const endpoint = task.value?.endpoints.find((item) => item.sourceProjectId === endpointId)
  if (!endpoint?.targetProjectId) return
  const data = await loadWorkbench(endpoint.targetProjectId)
  if (!data) return
  snapshots.value = {
    ...snapshots.value,
    [endpointId]: {
      project: data.project,
      pages: data.pages,
      htmlByPage: data.htmlByPage,
    },
  }
  if (preferredPageId) selectedPageKey.value = `${endpointId}:${preferredPageId}`
  ensureSelection(endpointId)
  if (selectedPage.value?.endpointId === endpointId) previewRevision.value++
}

async function refreshWorkspaces() {
  if (!task.value) return
  await Promise.all(
    task.value.endpoints
      .filter((endpoint) => !!endpoint.targetProjectId)
      .map((endpoint) => refreshEndpoint(endpoint.sourceProjectId)),
  )
  ensureSelection()
}

async function refreshSourceWorkspaces() {
  if (!task.value) return
  const entries = await Promise.all(
    task.value.endpoints.map(async (endpoint) => {
      const data = await loadWorkbench(endpoint.sourceProjectId)
      return data ? [endpoint.sourceProjectId, {
        project: data.project,
        pages: data.pages,
        htmlByPage: data.htmlByPage,
      }] as const : null
    }),
  )
  sourceSnapshots.value = Object.fromEntries(entries.filter((entry) => entry !== null))
}

function toggleEndpoint(endpointId: string) {
  const next = new Set(expandedEndpointIds.value)
  if (next.has(endpointId)) next.delete(endpointId)
  else next.add(endpointId)
  expandedEndpointIds.value = next
}

function selectPage(row: PageChangeRow) {
  selectedPageKey.value = row.key
}

function openTargetWorkbench() {
  const projectId = selectedEndpoint.value?.targetProjectId
  if (!projectId) return
  const href = router.resolve(`/project/${projectId}`).href
  window.open(href, '_blank', 'noopener,noreferrer')
}

function applyPageChange(event: IterationPageChangeEvent) {
  const key = `${event.endpointSourceProjectId}:${event.pageId}`
  expandedEndpointIds.value = new Set([...expandedEndpointIds.value, event.endpointSourceProjectId])
  selectedPageKey.value = key
  const snapshot = snapshots.value[event.endpointSourceProjectId]
  if (snapshot) {
    const pages = snapshot.pages.map((page) =>
      page.id === event.pageId
        ? {
            ...page,
            genStatus: (event.status === 'completed' ? 'done' : event.status) as Page['genStatus'],
            iterationInitialized: event.status === 'completed' ? true : page.iterationInitialized,
            errorMessage: event.error,
          }
        : page,
    )
    const htmlByPage = new Map(snapshot.htmlByPage)
    if (event.html) htmlByPage.set(event.pageId, event.html)
    snapshots.value = {
      ...snapshots.value,
      [event.endpointSourceProjectId]: { ...snapshot, pages, htmlByPage },
    }
  }
  if (event.html) liveHtml.value = { ...liveHtml.value, [key]: event.html }
  previewRevision.value++
  if (!snapshot || event.status !== 'generating')
    void refreshEndpoint(event.endpointSourceProjectId, event.pageId)
}

function applySavedTask(value: IterationTask) {
  task.value = value
  for (const endpoint of value.endpoints) {
    if (endpoint.targetProjectId && !snapshots.value[endpoint.sourceProjectId])
      void refreshEndpoint(endpoint.sourceProjectId)
  }
}

async function load() {
  loading.value = true
  try {
    const id = String(route.params.id ?? '')
    task.value = (await iterationTaskRepo.list()).find((item) => item.id === id) ?? null
    if (task.value) {
      expandedEndpointIds.value = new Set(task.value.endpoints.map((endpoint) => endpoint.sourceProjectId))
      await refreshSourceWorkspaces()
      await refreshWorkspaces()
    }
  } finally {
    loading.value = false
  }
}

async function run() {
  if (!task.value || !canRun.value) return
  controller = new AbortController()
  running.value = true
  try {
    task.value = await executeIterationTask({
      task: task.value,
      projects: [],
      getProvider: settings.getProvider,
      maxTokens: settings.genParams.maxTokens,
      temperature: settings.genParams.temperature,
      tailwindCdnUrl: settings.genParams.tailwindCdnUrl,
      concurrency: settings.genParams.concurrency,
      signal: controller.signal,
      onStage(value) { stage.value = value },
      onSaved: applySavedTask,
      onPageChange: applyPageChange,
    })
    await refreshWorkspaces()
    if (task.value.status === 'completed') message.success('多端迭代已完成')
    else message.warning('本轮迭代已结束，失败页面可以继续执行')
  } catch (error) {
    if (!controller?.signal.aborted)
      message.error(error instanceof Error ? error.message : '任务执行中断')
    await load()
  } finally {
    controller = null
    running.value = false
    stage.value = ''
  }
}

async function submitAdjustment() {
  const current = task.value
  const content = adjustmentText.value.trim()
  if (!current || !content || running.value || adjustmentSaving.value || current.status === 'cancelled') return
  adjustmentSaving.value = true
  try {
    current.conversation ??= []
    current.conversation.push({ id: nanoid(), role: 'user', content, createdAt: Date.now() })
    for (const endpoint of current.endpoints) {
      endpoint.aiSession.messages.push({ role: 'user', content: `用户对本次多端迭代提出补充调整：${content}\n请结合此前会话、现有规划和已生成结果，重新输出完整可执行规划。未被补充要求影响的内容保持不变。` })
      endpoint.aiSession.updatedAt = Date.now()
      endpoint.plan = undefined
      endpoint.relatedPages = undefined
      endpoint.planNeedsApply = !!endpoint.targetProjectId
      endpoint.status = 'pending'
      endpoint.error = undefined
    }
    current.status = 'pending'
    current.error = undefined
    task.value = await iterationTaskRepo.save(current)
    adjustmentText.value = ''
    message.success('补充要求已写入原 AI 会话，正在重新规划')
    await run()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '补充调整失败')
  } finally {
    adjustmentSaving.value = false
  }
}

function stop() {
  controller?.abort()
  message.warning('已停止本轮执行，已完成的页面会继续保留')
}

function confirmCancel() {
  if (!task.value || task.value.status === 'cancelled') return
  dialog.warning({
    title: '撤销任务',
    content: '前往任务管理页选择保留已创建版本，或同时删除所有任务创建的新版本。',
    positiveText: '前往撤销',
    negativeText: '取消',
    onPositiveClick: () => router.push('/iterations'),
  })
}

onMounted(async () => {
  await load()
})
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <div class="task-workbench">
    <header class="task-topbar">
      <n-button quaternary size="small" @click="router.push('/iterations')">← 多端迭代</n-button>
      <strong>{{ task?.title ?? '任务工作区' }}</strong>
      <n-tag
        v-if="task"
        size="small"
        :bordered="false"
        :type="task.status === 'completed' ? 'success' : task.status === 'failed' ? 'error' : 'warning'"
      >
        {{ task.status === 'completed' ? '已完成' : task.status === 'failed' ? '部分失败' : task.status === 'cancelled' ? '已撤销' : '执行中' }}
      </n-tag>
      <span class="task-stage">{{ stage || (task ? `${completedCount}/${task.endpoints.length} 个端完成` : '') }}</span>
      <n-button v-if="canRun" size="small" type="primary" @click="run">
        {{ task?.status === 'pending' ? '开始统一规划' : '继续执行' }}
      </n-button>
      <n-button v-if="running" size="small" type="error" secondary @click="stop">停止</n-button>
      <n-button
        v-if="task && !['completed', 'cancelled'].includes(task.status)"
        size="small"
        quaternary
        type="error"
        @click="confirmCancel"
      >
        撤销
      </n-button>
    </header>

    <n-spin v-if="loading" class="workbench-loading" />
    <n-result v-else-if="!task" status="404" title="任务不存在">
      <template #footer><n-button @click="router.push('/iterations')">返回任务列表</n-button></template>
    </n-result>

    <div v-else class="task-columns">
      <aside class="endpoint-sidebar">
        <div class="panel-title">
          <strong>端与页面变化</strong>
          <span>{{ completedCount }}/{{ task.endpoints.length }}</span>
        </div>
        <div class="endpoint-tree">
          <section v-for="endpoint in task.endpoints" :key="endpoint.sourceProjectId" class="endpoint-group">
            <button class="endpoint-header" @click="toggleEndpoint(endpoint.sourceProjectId)">
              <span class="tree-chevron" :class="{ expanded: expandedEndpointIds.has(endpoint.sourceProjectId) }">›</span>
              <span class="status-dot" :data-status="endpoint.status" />
              <span class="endpoint-heading">
                <strong>{{ endpoint.projectName }}</strong>
                <small>{{ endpoint.sourceIteration }} → {{ endpoint.targetIteration }}</small>
              </span>
              <span class="endpoint-progress">
                <b>{{ endpointProgress(endpoint).done }}/{{ endpointProgress(endpoint).total }}</b>
                <small>{{ endpointStatusText(endpoint) }}</small>
              </span>
            </button>
            <div v-if="expandedEndpointIds.has(endpoint.sourceProjectId)" class="page-change-list">
              <button
                v-for="row in pageRows(endpoint)"
                :key="row.key"
                :class="['page-change-row', { active: selectedPageKey === row.key }]"
                :style="{ paddingLeft: `${9 + row.depth * 14}px` }"
                @click="selectPage(row)"
              >
                <span class="page-status" :data-status="row.status">
                  <n-spin v-if="row.status === 'generating'" :size="12" />
                </span>
                <span class="page-name">
                  <strong>{{ row.name }}</strong>
                  <small>{{ row.action === 'update' ? '修改页面' : '新增页面' }}</small>
                </span>
                <span class="page-state">{{ pageStatusText(row.status) }}</span>
              </button>
              <div v-if="!pageRows(endpoint).length" class="page-empty">
                <n-spin v-if="running && !planningComplete" :size="14" />
                <span>
                  {{ running && !planningComplete
                    ? '正在统一规划新增与修改页面'
                    : endpoint.error || (planningComplete ? '本次没有规划页面变化' : '等待开始统一规划') }}
                </span>
                <n-button
                  v-if="!running && canRun && (endpoint.sourceProjectId === task.primarySourceId || endpoint.status === 'failed')"
                  size="tiny"
                  type="primary"
                  @click.stop="run"
                >
                  {{ task.status === 'pending' ? '开始统一规划' : '继续执行' }}
                </n-button>
              </div>
              <div v-if="pageRows(endpoint).length && !running && endpoint.status === 'failed'" class="endpoint-retry">
                <n-button size="tiny" type="primary" secondary @click.stop="run">继续失败页面</n-button>
              </div>
            </div>
          </section>
        </div>
      </aside>

      <main class="preview-panel">
        <div class="preview-toolbar">
          <div v-if="selectedPage" class="preview-title">
            <strong>{{ selectedPage.name }}</strong>
            <n-tag size="small" :bordered="false" :type="selectedPage.action === 'create' ? 'success' : 'info'">
              {{ selectedPage.action === 'create' ? '新增' : '修改' }}
            </n-tag>
            <n-tag
              size="small"
              :bordered="false"
              :type="selectedPage.status === 'completed' ? 'success' : selectedPage.status === 'failed' ? 'error' : 'warning'"
            >
              {{ pageStatusText(selectedPage.status) }}
            </n-tag>
          </div>
          <span v-else>选择左侧页面查看迭代界面</span>
          <n-button
            v-if="selectedEndpoint?.targetProjectId"
            size="small"
            secondary
            @click="openTargetWorkbench"
          >
            打开项目工作区
          </n-button>
        </div>
        <div class="preview-stage">
          <template v-if="selectedPage">
            <div v-if="previewHtml" class="prototype-frame-wrap">
              <iframe
                :key="previewKey"
                class="prototype-frame"
                :srcdoc="previewHtml"
                :title="`${selectedPage.name} 原型预览`"
                sandbox="allow-scripts allow-forms allow-modals"
              />
              <div v-if="selectedPage.status === 'generating'" class="preview-progress">
                <n-spin :size="18" />
                <div><strong>正在迭代此页面</strong><span>当前显示旧版，生成完成后自动更新</span></div>
              </div>
            </div>
            <div v-else class="preview-placeholder">
              <n-spin v-if="selectedPage.status === 'generating'" :size="28" />
              <div>
                <strong>{{ selectedPage.status === 'generating' ? '正在生成页面原型' : '页面尚未开始生成' }}</strong>
                <span>{{ selectedPage.action === 'create' ? '新增页面完成后将在这里显示' : '目标版本创建后将在这里显示旧版与迭代结果' }}</span>
              </div>
            </div>
          </template>
          <n-empty v-else description="AI 完成页面规划后，可在左侧选择页面查看" />
        </div>
      </main>

      <aside class="detail-panel">
        <div class="detail-tabs">
          <button :class="{ active: detailMode === 'change' }" @click="detailMode = 'change'">页面变更</button>
          <button :class="{ active: detailMode === 'conversation' }" @click="detailMode = 'conversation'">持续对话</button>
        </div>
        <template v-if="detailMode === 'change' && selectedPage">
          <dl class="change-summary">
            <dt>所属项目</dt><dd>{{ selectedEndpoint?.projectName }}</dd>
            <dt>目标版本</dt><dd>{{ selectedEndpoint?.targetIteration }}</dd>
            <dt>操作</dt><dd>{{ selectedPage.action === 'update' ? '在旧页面上迭代' : '创建新页面' }}</dd>
            <dt>状态</dt><dd>{{ pageStatusText(selectedPage.status) }}</dd>
          </dl>
          <section class="change-section">
            <strong>变更原因</strong>
            <p>{{ selectedPage.reason || '根据本次版本需求进行调整' }}</p>
          </section>
          <section v-if="selectedPage.blocks.length" class="change-section">
            <strong>涉及内容</strong>
            <ul><li v-for="block in selectedPage.blocks" :key="block">{{ block }}</li></ul>
          </section>
          <n-alert v-if="selectedPage.error" type="error" :bordered="false">{{ selectedPage.error }}</n-alert>
        </template>
        <template v-else-if="detailMode === 'change' && selectedEndpoint">
          <section class="endpoint-overview">
            <strong>{{ selectedEndpoint.projectName }}</strong>
            <span>{{ selectedEndpoint.sourceIteration }} → {{ selectedEndpoint.targetIteration }}</span>
            <p>{{ selectedEndpoint.plan?.summary || '正在等待该端的页面迭代规划。' }}</p>
          </section>
          <n-alert v-if="selectedEndpoint.error" type="error" :bordered="false">{{ selectedEndpoint.error }}</n-alert>
        </template>
        <template v-else-if="detailMode === 'conversation'">
          <div class="conversation-list">
            <div v-if="!task.conversation?.length" class="conversation-empty">可继续补充业务要求，AI 会沿用各端原有会话重新规划，并在已创建的目标版本中继续修改。</div>
            <article v-for="turn in task.conversation" :key="turn.id" :class="['conversation-turn', turn.role]">
              <strong>{{ turn.role === 'user' ? '你' : 'AI 规划' }}</strong>
              <p>{{ turn.content }}</p>
              <span>{{ formatTime(turn.createdAt) }}</span>
            </article>
          </div>
          <div class="conversation-compose">
            <n-input v-model:value="adjustmentText" type="textarea" :rows="5" maxlength="4000" show-count placeholder="继续补充需要新增、修改或重新规划的内容…" :disabled="running || adjustmentSaving || task.status === 'cancelled'" />
            <n-button type="primary" block :loading="adjustmentSaving || running" :disabled="!adjustmentText.trim() || task.status === 'cancelled'" @click="submitAdjustment">发送并继续规划修改</n-button>
          </div>
        </template>
        <div class="task-meta">创建于 {{ formatTime(task.createdAt) }}<br>更新于 {{ formatTime(task.updatedAt) }}</div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.task-workbench{height:100vh;display:flex;flex-direction:column;overflow:hidden;background:var(--qp-canvas-bg)}
.task-topbar{height:52px;display:flex;flex-shrink:0;align-items:center;gap:10px;padding:0 12px;border-bottom:1px solid var(--qp-border);background:var(--qp-pane)}
.task-topbar>strong{font-size:14px}.task-stage{min-width:0;flex:1;overflow:hidden;color:var(--qp-text-muted);font-size:11px;text-align:center;text-overflow:ellipsis;white-space:nowrap}.workbench-loading{margin:auto}
.task-columns{min-height:0;flex:1;display:grid;grid-template-columns:310px minmax(0,1fr) 300px}.endpoint-sidebar,.preview-panel,.detail-panel{min-height:0;background:var(--qp-pane)}.endpoint-sidebar{display:flex;flex-direction:column;border-right:1px solid var(--qp-border)}.detail-panel{overflow:auto;border-left:1px solid var(--qp-border)}
.panel-title{height:46px;display:flex;flex-shrink:0;align-items:center;justify-content:space-between;gap:8px;padding:0 14px;border-bottom:1px solid var(--qp-border)}.panel-title span{color:var(--qp-text-muted);font-size:11px}.endpoint-tree{min-height:0;overflow:auto}.endpoint-group{border-bottom:1px solid var(--qp-border)}
.endpoint-header{width:100%;display:grid;grid-template-columns:16px 9px minmax(0,1fr) auto;align-items:center;gap:8px;padding:12px;border:0;color:inherit;background:transparent;text-align:left;cursor:pointer}.endpoint-header:hover{background:var(--qp-hover)}.tree-chevron{color:var(--qp-text-muted);font-size:20px;line-height:1;transform:rotate(0);transition:transform .15s}.tree-chevron.expanded{transform:rotate(90deg)}.status-dot{width:8px;height:8px;border-radius:50%;background:#94a3b8}.status-dot[data-status=completed]{background:#22c55e}.status-dot[data-status=failed]{background:#ef4444}.status-dot[data-status=planning],.status-dot[data-status=generating]{background:#f59e0b}.endpoint-heading,.endpoint-progress{display:grid;gap:3px}.endpoint-heading strong{overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.endpoint-heading small,.endpoint-progress small{color:var(--qp-text-muted);font-size:10px}.endpoint-progress{text-align:right}.endpoint-progress b{font-size:11px}
.page-change-list{padding:0 8px 9px 30px}.page-change-row{width:100%;display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:7px;padding:8px 9px;border:0;border-radius:5px;color:inherit;background:transparent;text-align:left;cursor:pointer}.page-change-row:hover{background:var(--qp-hover)}.page-change-row.active{color:#6366f1;background:color-mix(in srgb,#6366f1 12%,transparent)}.page-status{display:grid;place-items:center;width:10px;height:10px;border:2px solid #94a3b8;border-radius:50%}.page-status[data-status=completed]{border-color:#22c55e;background:#22c55e}.page-status[data-status=failed]{border-color:#ef4444;background:#ef4444}.page-status[data-status=generating]{width:14px;height:14px;border:0}.page-name{min-width:0;display:grid;gap:2px}.page-name strong{overflow:hidden;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.page-name small,.page-state{color:var(--qp-text-muted);font-size:9px}.page-empty{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px;color:var(--qp-text-muted);font-size:10px;line-height:1.5}.page-empty>span{min-width:0;flex:1}.endpoint-retry{padding:7px 9px 2px;text-align:right}
.preview-panel{display:flex;flex-direction:column;min-width:0;background:var(--qp-canvas-bg)}.preview-toolbar{height:46px;display:flex;flex-shrink:0;align-items:center;justify-content:space-between;gap:12px;padding:0 14px;border-bottom:1px solid var(--qp-border);background:var(--qp-pane)}.preview-toolbar>span{color:var(--qp-text-muted);font-size:11px}.preview-title{min-width:0;display:flex;align-items:center;gap:7px}.preview-title>strong{overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.preview-stage{min-height:0;flex:1;display:grid;place-items:center;padding:18px;overflow:hidden}.prototype-frame-wrap{position:relative;width:100%;height:100%;overflow:hidden;border:1px solid var(--qp-border);background:white;box-shadow:0 8px 26px rgba(0,0,0,.08)}.prototype-frame{width:100%;height:100%;border:0;background:white}.preview-progress{position:absolute;top:14px;left:50%;display:flex;align-items:center;gap:10px;padding:9px 13px;border:1px solid rgba(99,102,241,.24);border-radius:6px;background:color-mix(in srgb,var(--qp-pane) 94%,transparent);box-shadow:0 8px 24px rgba(0,0,0,.14);transform:translateX(-50%);pointer-events:none}.preview-progress div{display:grid;gap:2px}.preview-progress strong{font-size:11px}.preview-progress span{color:var(--qp-text-muted);font-size:9px;white-space:nowrap}.preview-placeholder{display:flex;align-items:center;gap:14px;color:var(--qp-text-muted)}.preview-placeholder div{display:grid;gap:5px}.preview-placeholder strong{color:var(--qp-text);font-size:13px}.preview-placeholder span{font-size:11px}
.detail-panel{padding-bottom:20px}.change-summary{display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px;margin:0;padding:14px;font-size:11px}.change-summary dt{color:var(--qp-text-muted)}.change-summary dd{margin:0;overflow-wrap:anywhere}.change-section{margin:0 14px 14px;padding:12px;border:1px solid var(--qp-border);border-radius:5px}.change-section>strong{font-size:11px}.change-section p{margin:7px 0 0;color:var(--qp-text-muted);font-size:11px;line-height:1.65}.change-section ul{margin:8px 0 0;padding-left:18px}.change-section li{margin:5px 0;font-size:11px;line-height:1.5}.detail-panel :deep(.n-alert){margin:0 14px}.endpoint-overview{display:grid;gap:6px;margin:14px;padding:12px;border:1px solid var(--qp-border);border-radius:5px}.endpoint-overview span,.endpoint-overview p{color:var(--qp-text-muted);font-size:11px}.endpoint-overview p{margin:5px 0 0;line-height:1.65}.task-meta{margin:16px 14px;color:var(--qp-text-muted);font-size:10px;line-height:1.7}
.detail-tabs{height:46px;display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--qp-border)}.detail-tabs button{border:0;border-bottom:2px solid transparent;color:var(--qp-text-muted);background:transparent;cursor:pointer}.detail-tabs button.active{border-bottom-color:#6366f1;color:#6366f1}.conversation-list{display:grid;gap:10px;padding:12px}.conversation-empty{padding:12px;color:var(--qp-text-muted);font-size:11px;line-height:1.7;border:1px dashed var(--qp-border);border-radius:5px}.conversation-turn{padding:10px;border:1px solid var(--qp-border);border-radius:5px;background:var(--qp-canvas-bg)}.conversation-turn.user{border-color:color-mix(in srgb,#6366f1 35%,var(--qp-border))}.conversation-turn strong{font-size:10px}.conversation-turn p{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.65}.conversation-turn span{color:var(--qp-text-muted);font-size:9px}.conversation-compose{display:grid;gap:9px;padding:12px;border-top:1px solid var(--qp-border)}
@media(max-width:1100px){.task-columns{grid-template-columns:280px minmax(0,1fr)}.detail-panel{display:none}}@media(max-width:720px){.task-columns{grid-template-columns:1fr}.endpoint-sidebar{display:none}.task-topbar{height:auto;flex-wrap:wrap;padding-block:8px}.task-stage{order:2;flex-basis:100%}.preview-stage{padding:8px}}
</style>
