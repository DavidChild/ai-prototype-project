<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import TenantAdminShell from '@/components/account/TenantAdminShell.vue'
import CreateIterationDialog from '@/components/project/CreateIterationDialog.vue'
import { iterationTaskRepo, projectRepo } from '@/services/storage/repositories'
import type { IterationTask } from '@/types/iterationTask'
import type { Project } from '@/types/project'
import { formatTime } from '@/utils/format'

const router = useRouter()
const message = useMessage()
const tasks = ref<IterationTask[]>([])
const projects = ref<Project[]>([])
const loading = ref(true)
const filter = ref<'active' | 'completed' | 'cancelled' | 'all'>('active')
const cancelShow = ref(false)
const cancelTarget = ref<IterationTask | null>(null)
const cancelMode = ref<'keep' | 'delete'>('keep')
const cancelling = ref(false)
const createShow = ref(false)
const sourceSelectShow = ref(false)
const sourceProjectId = ref<string | null>(null)
const createSource = ref<Project | null>(null)

const sourceOptions = computed(() => {
  const latestByFamily = new Map<string, Project>()
  for (const project of projects.value.filter((item) => !item.hidden)) {
    const familyId = project.familyId ?? project.id
    const current = latestByFamily.get(familyId)
    if (!current || project.updatedAt > current.updatedAt) latestByFamily.set(familyId, project)
  }
  return [...latestByFamily.values()].map((project) => ({
    label: `${project.name} · ${project.iteration ?? 'v1.0'} · ${project.platform === 'pc' ? 'PC' : '移动端'}`,
    value: project.id,
  }))
})

const visibleTasks = computed(() => tasks.value.filter((task) => {
  if (filter.value === 'active') return ['pending', 'running', 'failed'].includes(task.status)
  if (filter.value === 'completed') return task.status === 'completed'
  if (filter.value === 'cancelled') return task.status === 'cancelled'
  return true
}))

function statusText(task: IterationTask) {
  return { pending: '等待执行', running: '执行中断', failed: '部分失败', completed: '已完成', cancelled: '已撤销' }[task.status]
}
function statusType(task: IterationTask) {
  return task.status === 'completed' ? 'success' : task.status === 'failed' ? 'error' : task.status === 'cancelled' ? 'default' : 'warning'
}
async function load() {
  loading.value = true
  try { [tasks.value, projects.value] = await Promise.all([iterationTaskRepo.listSummaries(), projectRepo.list()]) }
  finally { loading.value = false }
}
function openCreate() {
  sourceProjectId.value = null
  sourceSelectShow.value = true
}
function confirmCreateSource() {
  createSource.value = projects.value.find(
    (project) => project.id === sourceProjectId.value && !project.hidden,
  ) ?? null
  if (!createSource.value) return
  sourceSelectShow.value = false
  createShow.value = true
}
function handleTaskReady(task: IterationTask) {
  tasks.value.unshift(task)
  void router.push(`/iterations/${task.id}`)
}
function openCancel(task: IterationTask) {
  cancelTarget.value = task
  cancelMode.value = 'keep'
  cancelShow.value = true
}
async function submitCancel() {
  if (!cancelTarget.value || cancelling.value) return
  cancelling.value = true
  try {
    const saved = await iterationTaskRepo.cancel(cancelTarget.value.id, cancelMode.value === 'delete')
    const index = tasks.value.findIndex((task) => task.id === saved.id)
    if (index >= 0) tasks.value[index] = saved
    cancelShow.value = false
    message.success(cancelMode.value === 'delete' ? '任务已撤销，已创建的新版本已删除' : '任务已撤销，已创建的新版本已保留')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '任务撤销失败')
  } finally { cancelling.value = false }
}
onMounted(load)
</script>

<template>
  <TenantAdminShell active="iterations" title="多端迭代" description="管理跨项目端版本迭代任务，查看执行进度并继续失败内容。">
    <template #actions><n-button secondary @click="load">刷新</n-button><n-button type="primary" @click="openCreate">+ 新建多端迭代</n-button></template>
    <div class="task-toolbar">
      <n-radio-group v-model:value="filter" size="small">
        <n-radio-button value="active">待处理</n-radio-button>
        <n-radio-button value="completed">已完成</n-radio-button>
        <n-radio-button value="cancelled">已撤销</n-radio-button>
        <n-radio-button value="all">全部</n-radio-button>
      </n-radio-group>
      <n-text depth="3">{{ visibleTasks.length }} 个任务</n-text>
    </div>
    <n-spin v-if="loading" class="task-loading" />
    <n-empty v-else-if="!visibleTasks.length" description="当前没有迭代任务" class="task-empty" />
    <div v-else class="task-grid">
      <article v-for="task in visibleTasks" :key="task.id" class="task-card">
        <header>
          <div><strong>{{ task.title }}</strong><span>更新于 {{ formatTime(task.updatedAt) }}</span></div>
          <n-tag size="small" :bordered="false" :type="statusType(task)">{{ statusText(task) }}</n-tag>
        </header>
        <div class="endpoint-list">
          <div v-for="endpoint in task.endpoints" :key="endpoint.sourceProjectId" class="endpoint-row">
            <span class="endpoint-status" :data-status="endpoint.status" />
            <div><strong>{{ endpoint.projectName }}</strong><span>{{ endpoint.sourceIteration }} → {{ endpoint.targetIteration }}</span></div>
            <em>{{ endpoint.status === 'completed' ? '完成' : endpoint.status === 'failed' ? '失败' : endpoint.status === 'generating' ? '生成中' : endpoint.status === 'planning' ? '规划中' : '待执行' }}</em>
          </div>
        </div>
        <p v-if="task.error" class="task-error">{{ task.error }}</p>
        <footer>
          <span>{{ task.endpoints.length }} 个端 · {{ task.endpoints.filter((item) => item.status === 'completed').length }} 个完成</span>
          <n-space size="small">
            <n-button size="small" secondary @click="router.push(`/iterations/${task.id}`)">{{ task.status === 'completed' || task.status === 'cancelled' ? '查看工作区' : '进入工作区' }}</n-button>
            <n-button v-if="!['completed','cancelled'].includes(task.status)" size="small" quaternary type="error" @click="openCancel(task)">撤销任务</n-button>
          </n-space>
        </footer>
      </article>
    </div>

    <n-modal v-model:show="cancelShow" preset="card" title="撤销多端迭代任务" style="width:min(560px,94vw)" :mask-closable="!cancelling">
      <n-alert type="warning" :bordered="false" class="cancel-note">撤销后任务不能继续执行。请选择已经由任务创建的新版本如何处理。</n-alert>
      <n-radio-group v-model:value="cancelMode" class="cancel-options">
        <n-radio value="keep"><strong>保留已创建版本</strong><span>停止后续执行，现有版本和已生成页面继续保留。</span></n-radio>
        <n-radio value="delete"><strong>同时删除各端新版本</strong><span>删除该任务已经创建的所有端新版本及其页面、历史和文档。</span></n-radio>
      </n-radio-group>
      <template #footer><n-space justify="end"><n-button :disabled="cancelling" @click="cancelShow=false">取消</n-button><n-button type="error" :loading="cancelling" @click="submitCancel">确认撤销</n-button></n-space></template>
    </n-modal>
    <n-modal v-model:show="sourceSelectShow" preset="card" title="选择主项目" style="width:min(500px,94vw)">
      <n-form label-placement="top"><n-form-item label="主项目"><n-select v-model:value="sourceProjectId" filterable :options="sourceOptions" placeholder="选择本次迭代的主项目" /></n-form-item></n-form>
      <n-alert type="info" :bordered="false">下一步还可以继续添加运营管理端、B/C 端、小程序等其他同步迭代项目。</n-alert>
      <template #footer><n-space justify="end"><n-button @click="sourceSelectShow=false">取消</n-button><n-button type="primary" :disabled="!sourceProjectId" @click="confirmCreateSource">下一步</n-button></n-space></template>
    </n-modal>
    <CreateIterationDialog v-model:show="createShow" :source="createSource" :projects="projects" @task-ready="handleTaskReady" />
  </TenantAdminShell>
</template>

<style scoped>
.task-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}.task-loading{display:block;margin:80px auto}.task-empty{margin-top:80px}.task-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.task-card{display:grid;gap:14px;padding:16px;border:1px solid var(--qp-border);border-radius:6px;background:var(--qp-pane)}.task-card header,.task-card footer,.endpoint-row{display:flex;align-items:center}.task-card header,.task-card footer{justify-content:space-between;gap:14px}.task-card header>div{display:grid;gap:3px}.task-card header strong{font-size:15px}.task-card header span,.task-card footer>span,.endpoint-row span{color:var(--qp-text-muted);font-size:11px}.endpoint-list{display:grid;border:1px solid var(--qp-border);border-radius:5px}.endpoint-row{gap:9px;padding:9px 10px;border-bottom:1px solid var(--qp-border)}.endpoint-row:last-child{border-bottom:0}.endpoint-row>div{min-width:0;display:grid;gap:2px;flex:1}.endpoint-row strong{font-size:12px}.endpoint-row em{color:var(--qp-text-muted);font-size:11px;font-style:normal}.endpoint-status{width:8px;height:8px;border-radius:50%;background:#94a3b8}.endpoint-status[data-status=completed]{background:#22c55e}.endpoint-status[data-status=failed]{background:#ef4444}.endpoint-status[data-status=planning],.endpoint-status[data-status=generating]{background:#f59e0b}.task-error{margin:0;padding:8px 10px;color:#ef4444;background:color-mix(in srgb,#ef4444 8%,transparent);font-size:11px;white-space:pre-line}.cancel-note{margin-bottom:16px}.cancel-options{display:grid;gap:10px}.cancel-options :deep(.n-radio){display:flex;align-items:flex-start;padding:12px;border:1px solid var(--qp-border);border-radius:6px}.cancel-options strong,.cancel-options span{display:block}.cancel-options span{margin-top:3px;color:var(--qp-text-muted);font-size:11px}@media(max-width:900px){.task-grid{grid-template-columns:1fr}}
</style>
