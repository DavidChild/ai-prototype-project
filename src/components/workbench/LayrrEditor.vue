<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useWorkbenchStore } from '@/stores/workbench'
import { useSettingsStore } from '@/stores/settings'
import { versionRepo } from '@/services/storage/repositories'
import { editWithLayrr, type LayrrEdit } from '@/services/generation/layrrEdit'
import type { GenerationConstraint } from '@/types/generationConstraint'
const wb = useWorkbenchStore()
const settings = useSettingsStore()
const message = useMessage()
const emit = defineEmits<{ preview: [url: string]; error: [message: string] }>()
const show = ref(false)
const busy = ref(false)
const working = ref(false)
const saving = ref(false)
const saveStatus = ref('等待在编辑窗口中提交修改')
const connectionError = ref('')
const previewRevision = ref(0)
type Submission = { id: string; html: string; feedbackText: string; source?: 'layrr' | 'ai-local' }
type SubmissionResult = { success: boolean; message: string }
const submissionResults = new Map<string, SubmissionResult>()
const workspace = ref<{
  id: string
  url: string
  editorUrl: string
  file: string
  projectId: string
  pageId: string
  baseline: string
  original: string
  label: string
} | null>(null)
const html = ref('')
const changed = computed(() => workspace.value && html.value !== workspace.value.original)
let timer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
let disposed = false
let generation = 0
const available = computed(
  () =>
    !!(
      wb.project &&
      wb.selectedPage?.currentVersionId &&
      wb.selectedHtml &&
      !wb.selectedPage.spec.groupOnly &&
      !wb.loading &&
      !wb.refining &&
      !['generating', 'queued'].includes(wb.selectedPage.genStatus)
    ),
)
watch(
  () => (workspace.value ? workspace.value.url + '?revision=' + previewRevision.value : ''),
  (url) => emit('preview', url),
  { immediate: true },
)
watch(connectionError, (error) => emit('error', error))
watch(
  [working, saving],
  () => {
    wb.localEditingPageId = working.value || saving.value ? (workspace.value?.pageId ?? null) : null
  },
  { flush: 'sync' },
)
async function api(path: string, method = 'GET', data?: unknown) {
  const response = await fetch('/api/layrr' + path, {
    method,
    headers: { 'x-quickpage-layrr': '1', ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  })
  if (!response.headers.get('content-type')?.includes('application/json')) {
    const responseText = (await response.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const detail = responseText ? `：${responseText.slice(0, 160)}` : ''
    throw new Error(`Layrr 服务响应异常（HTTP ${response.status}）${detail}`)
  }
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Layrr 请求失败')
  return result
}
async function start() {
  await reset()
  const page = wb.selectedPage
  const project = wb.project
  if (!available.value || !page?.currentVersionId || !project || disposed) return
  const requestGeneration = generation
  busy.value = true
  const baseline = page.currentVersionId
  const original = wb.selectedHtml
  const constraintMap = new Map<string, GenerationConstraint>()
  for (const item of project.generationConstraints ?? []) constraintMap.set(item.id, item)
  if (page.spec.constraints?.mode === 'custom') {
    for (const item of page.spec.constraints.items) constraintMap.set(item.sourceConstraintId ?? item.id, item)
  }
  try {
    const result = await api('', 'POST', {
      projectId: project.id,
      pageId: page.id,
      baseline,
      html: original,
      constraints: [...constraintMap.values()].map(({ name, description, html }) => ({
        name,
        description,
        html,
      })),
    })
    if (
      disposed ||
      requestGeneration !== generation ||
      !available.value ||
      wb.project?.id !== project.id ||
      wb.selectedPageId !== page.id ||
      wb.selectedPage?.currentVersionId !== baseline
    ) {
      await api('/' + result.id, 'DELETE').catch(() => {})
      return
    }
    workspace.value = {
      ...result,
      projectId: project.id,
      pageId: page.id,
      baseline,
      original,
      label: project.name + ' / ' + (project.iteration ?? 'v1.0') + ' / ' + page.spec.name,
    }
    html.value = original
    saveStatus.value = '等待在编辑窗口中提交修改'
    connectionError.value = ''
    void poll()
  } catch (error) {
    if (!disposed && requestGeneration === generation)
      connectionError.value = error instanceof Error ? error.message : 'AI 工作区启动失败'
  } finally {
    if (requestGeneration === generation) busy.value = false
  }
}
async function open() {
  if (busy.value || !available.value) return
  const popup = window.open('about:blank', '_blank')
  if (popup) popup.opener = null
  if (!workspace.value) await start()
  if (!workspace.value) {
    popup?.close()
    return
  }
  show.value = true
  if (popup) popup.location.href = workspace.value.editorUrl
  else message.warning('请允许本站弹出窗口，然后重新打开手动局部编辑')
}
async function poll() {
  const session = workspace.value
  if (!session || disposed) return
  try {
    const data = (await api('/' + session.id)) as {
      html: string
      job: { id: string; edit: LayrrEdit } | null
      submission: Submission | null
    }
    if (workspace.value !== session || disposed) return
    html.value = data.html
    connectionError.value = ''
    if (data.submission) await saveSubmission(data.submission)
    if (workspace.value !== session || disposed) return
    if (data.job) {
      working.value = true
      controller = new AbortController()
      try {
        const resolved = settings.resolveModel('generation', wb.project?.modelOverride)
        if (!resolved || wb.project?.id !== session.projectId)
          throw new Error('未配置可用的生成模型，请在设置中配置后重试')
        const updated = await editWithLayrr({
          html: data.html,
          edit: data.job.edit,
          ...resolved,
          maxTokens: settings.genParams.maxTokens,
          signal: controller.signal,
        })
        if (disposed || workspace.value !== session) return
        const completed = await api('/' + session.id, 'POST', {
          jobId: data.job.id,
          success: true,
          html: updated,
        })
        if (disposed || workspace.value !== session) return
        html.value = updated
        if (completed.submission) await saveSubmission(completed.submission)
      } catch (error) {
        if (!disposed && workspace.value === session)
          await api('/' + session.id, 'POST', {
            jobId: data.job.id,
            success: false,
            message: error instanceof Error ? error.message : '局部修改失败',
          })
      } finally {
        if (workspace.value === session) {
          working.value = false
          controller = undefined
        }
      }
    }
  } catch (error) {
    if (!disposed && workspace.value === session) {
      const detail = error instanceof Error ? error.message : '工作区连接中断'
      saveStatus.value = detail + '，正在重试连接'
      connectionError.value = detail
    }
  }
  if (!disposed && workspace.value === session) timer = setTimeout(() => void poll(), 1000)
}
async function saveSubmission(submission: Submission) {
  const session = workspace.value
  if (!session || disposed) return
  saving.value = true
  saveStatus.value = '正在自动保存到页面历史…'
  let result = submissionResults.get(submission.id)
  if (!result) {
    try {
      const version = await versionRepo.importLayrr(
        session.projectId,
        session.pageId,
        session.baseline,
        submission.html,
        submission.feedbackText,
        submission.id,
        submission.source ?? 'layrr',
      )
      const baseline = session.baseline
      session.baseline = version.id
      session.original = submission.html
      if (wb.project?.id === session.projectId) {
        const page = wb.pages.find((p) => p.id === session.pageId)
        if (page && (page.currentVersionId === baseline || page.currentVersionId === version.id)) {
          page.currentVersionId = version.id
          page.genStatus = 'done'
          page.errorMessage = undefined
          page.reviewPending = (submission.source ?? 'layrr') === 'ai-local'
          page.updatedAt = version.createdAt
          wb.htmlByPage.set(session.pageId, submission.html)
        }
        const versions = await versionRepo.listByPage(session.pageId).catch(() => undefined)
        if (
          versions &&
          wb.project?.id === session.projectId &&
          wb.selectedPageId === session.pageId
        )
          wb.versions = versions
      }
      result = { success: true, message: `已保存为 v${version.versionNumber}` }
    } catch (error) {
      result = { success: false, message: error instanceof Error ? error.message : '保存失败' }
    }
    if (workspace.value !== session || disposed) return
    submissionResults.set(submission.id, result)
    if (submissionResults.size > 20)
      submissionResults.delete(submissionResults.keys().next().value!)
    // AI results refresh only the isolated Layrr frame. Manual submissions need one preview sync.
    if (result.success && submission.source !== 'ai-local') previewRevision.value++
  }
  try {
    await api('/' + session.id, 'POST', { submissionId: submission.id, ...result })
    if (workspace.value !== session || disposed) return
    saveStatus.value = result.message
    if (result.success) message.success(result.message)
    else message.error(result.message)
  } finally {
    if (workspace.value === session) saving.value = false
  }
}
async function reset() {
  generation++
  controller?.abort()
  controller = undefined
  clearTimeout(timer)
  const session = workspace.value
  workspace.value = null
  show.value = false
  working.value = false
  saving.value = false
  busy.value = false
  connectionError.value = ''
  previewRevision.value = 0
  submissionResults.clear()
  if (session) await api('/' + session.id, 'DELETE').catch(() => {})
}
watch(
  () =>
    [
      wb.project?.id,
      wb.selectedPageId,
      wb.selectedPage?.currentVersionId,
      available.value,
    ] as const,
  () => {
    const session = workspace.value
    if (!available.value) {
      void reset()
      return
    }
    if (
      session?.projectId === wb.project?.id &&
      session?.pageId === wb.selectedPageId &&
      session?.baseline === wb.selectedPage?.currentVersionId
    )
      return
    void start()
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  disposed = true
  reset()
})
</script>
<template>
  <n-button
    v-if="connectionError && available"
    size="tiny"
    secondary
    :loading="busy"
    :disabled="working || saving"
    @click="start"
  >
    重连 AI 工作区
  </n-button>
  <n-tag v-if="working || saving" size="tiny" type="info" :bordered="false">
    {{ working ? 'AI 局部修改中…' : '保存版本中…' }}
  </n-tag>
  <n-button
    v-if="wb.selectedHtml && !wb.selectedPage?.spec.groupOnly"
    size="tiny"
    secondary
    :loading="busy"
    :disabled="!available || working || saving"
    @click="open"
    >手动局部编辑</n-button
  >
  <n-modal
    :show="show"
    preset="card"
    title="手动局部编辑工作区"
    style="width: 640px; max-width: 95vw"
    :closable="false"
    :mask-closable="false"
    :close-on-esc="false"
  >
    <n-space vertical>
      <n-text>{{ workspace?.label }}</n-text>
      <n-alert type="info" :bordered="false"
        >手动编辑直接载入当前页面
        HTML，支持拖动、缩放、撤销与重做。点击“写入AI工作区”并填写修改备注后，会自动保存到当前迭代的页面历史，版本号自动生成，无需再次确认。可在手动编辑窗口继续修改、重复提交。请保持本窗口打开；若新窗口被拦截，请允许本站弹出窗口后重新打开手动局部编辑。</n-alert
      >
      <n-text depth="3">{{
        working
          ? '正在使用当前服务商生成局部补丁…'
          : saving
            ? '正在自动保存到页面历史…'
            : saveStatus
      }}</n-text>
      <n-text depth="3" style="font-size: 11px; overflow-wrap: anywhere"
        >本地文件：{{ workspace?.file }}</n-text
      >
      <n-text depth="3">{{
        changed
          ? '工作区有修改，请在编辑窗口填写备注并提交。'
          : '已提交的修改保存在页面历史中；回滚请使用“版本”页签。'
      }}</n-text>
    </n-space>
    <template #footer
      ><n-space justify="end">
        <n-button :disabled="busy || saving || working" @click="show = false">关闭</n-button>
      </n-space></template
    >
  </n-modal>
</template>
