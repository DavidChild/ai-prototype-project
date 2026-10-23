<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useWorkbenchStore } from '@/stores/workbench'
import { useSettingsStore } from '@/stores/settings'
import { versionRepo } from '@/services/storage/repositories'
import { editWithLayrr, type LayrrEdit } from '@/services/generation/layrrEdit'
const wb = useWorkbenchStore()
const settings = useSettingsStore()
const message = useMessage()
const show = ref(false)
const busy = ref(false)
const working = ref(false)
const workspace = ref<{
  id: string
  url: string
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
async function api(path: string, method = 'GET', data?: unknown) {
  const response = await fetch('/api/layrr' + path, {
    method,
    headers: { 'x-quickpage-layrr': '1', ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  })
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('Layrr 仅在 npm run dev 下可用，请重启开发服务')
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Layrr 请求失败')
  return result
}
async function open() {
  if (busy.value) return
  if (workspace.value) {
    show.value = true
    window.open(workspace.value.url + 'manual', '_blank', 'noopener,noreferrer')
    return
  }
  const page = wb.selectedPage
  const project = wb.project
  if (!page || !project || !page.currentVersionId || !wb.selectedHtml || busy.value) return
  busy.value = true
  const popup = window.open('about:blank', '_blank')
  if (popup) popup.opener = null
  const baseline = page.currentVersionId
  const original = wb.selectedHtml
  try {
    const result = await api('', 'POST', {
      projectId: project.id,
      pageId: page.id,
      baseline,
      html: original,
    })
    if (disposed) {
      await api('/' + result.id, 'DELETE')
      popup?.close()
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
    show.value = true
    if (popup) popup.location.href = result.url + 'manual'
    void poll()
  } catch (error) {
    popup?.close()
    message.error(error instanceof Error ? error.message : '启动失败')
  } finally {
    busy.value = false
  }
}
async function poll() {
  const session = workspace.value
  if (!session || disposed) return
  try {
    const data = (await api('/' + session.id)) as {
      html: string
      job: { id: string; edit: LayrrEdit } | null
    }
    if (workspace.value !== session || disposed) return
    html.value = data.html
    if (data.job) {
      working.value = true
      controller = new AbortController()
      try {
        const resolved = settings.resolveModel('generation', wb.project?.modelOverride)
        if (!resolved || wb.project?.id !== session.projectId)
          throw new Error('项目或模型已切换，请重新打开 Layrr')
        const updated = await editWithLayrr({
          html: data.html,
          edit: data.job.edit,
          ...resolved,
          maxTokens: settings.genParams.maxTokens,
          signal: controller.signal,
        })
        if (disposed || workspace.value !== session) return
        await api('/' + session.id, 'POST', { jobId: data.job.id, success: true, html: updated })
        html.value = updated
      } catch (error) {
        if (!disposed && workspace.value === session)
          await api('/' + session.id, 'POST', {
            jobId: data.job.id,
            success: false,
            message: error instanceof Error ? error.message : '局部修改失败',
          })
      } finally {
        working.value = false
        controller = undefined
      }
    }
  } catch (error) {
    if (!disposed) message.error(error instanceof Error ? error.message : '工作区连接中断')
    return
  }
  if (!disposed && workspace.value === session) timer = setTimeout(() => void poll(), 1000)
}
async function save() {
  const session = workspace.value
  if (!session || working.value || busy.value) return
  busy.value = true
  const savingHtml = html.value
  try {
    const version = await versionRepo.importLayrr(
      session.projectId,
      session.pageId,
      session.baseline,
      savingHtml,
    )
    if (wb.project?.id === session.projectId) {
      const page = wb.pages.find((p) => p.id === session.pageId)
      if (page) {
        page.currentVersionId = version.id
        page.genStatus = 'done'
        page.errorMessage = undefined
      }
      wb.htmlByPage.set(session.pageId, savingHtml)
      const versions = await versionRepo.listByPage(session.pageId)
      if (wb.project?.id === session.projectId && wb.selectedPageId === session.pageId)
        wb.versions = versions
    }
    session.baseline = version.id
    session.original = savingHtml
    message.success('已保存到原项目迭代的页面历史，可继续编辑或回滚')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    busy.value = false
  }
}
function close() {
  controller?.abort()
  clearTimeout(timer)
  const session = workspace.value
  workspace.value = null
  show.value = false
  if (session) void api('/' + session.id, 'DELETE').catch(() => {})
}
onBeforeUnmount(() => {
  disposed = true
  close()
})
</script>
<template>
  <n-button
    v-if="wb.selectedHtml && !wb.selectedPage?.spec.groupOnly"
    size="tiny"
    secondary
    :loading="busy"
    :disabled="wb.refining || ['generating', 'queued'].includes(wb.selectedPage?.genStatus ?? '')"
    @click="open"
    >局部编辑</n-button
  >
  <n-modal
    :show="show"
    preset="card"
    title="局部编辑工作区"
    style="width: 640px; max-width: 95vw"
    :closable="false"
    :mask-closable="false"
    :close-on-esc="false"
  >
    <n-space vertical>
      <n-text>{{ workspace?.label }}</n-text>
      <n-alert type="info" :bordered="false"
        >默认打开最初的手动编辑模式，直接载入当前页面 HTML，不调用 AI。点选元素可调整文字、图片、样式和布局，支持拖动、缩放、撤销与重做。完成后先点击“写入工作区”，再回到此处确认保存到当前迭代。若新窗口被浏览器拦截，请点击下方链接打开。请保持本窗口打开。</n-alert
      >
      <n-text depth="3">{{
        working
          ? '正在使用当前服务商生成局部补丁…'
          : changed
            ? '工作区有修改，确认效果后保存到页面历史'
            : '等待在手动编辑窗口中提交修改'
      }}</n-text>
      <n-text depth="3" style="font-size: 11px; overflow-wrap: anywhere"
        >本地文件：{{ workspace?.file }}</n-text
      >
      <a v-if="workspace" :href="workspace.url + 'manual'" target="_blank" rel="noopener noreferrer"
        >打开手动编辑工作区（不调用 AI）</a
      >
      <a v-if="workspace" :href="workspace.url + 'grid'" target="_blank" rel="noopener noreferrer"
        >打开独立网格编辑（GridStack，先转换预览）</a
      >
      <a v-if="workspace" :href="workspace.url" target="_blank" rel="noopener noreferrer"
        >打开 Layrr AI 局部编辑</a
      >
      <n-text depth="3">未确认的修改不会写入数据库；历史回滚请使用 QuickPage 的“版本”页签。</n-text>
    </n-space>
    <template #footer
      ><n-space justify="end">
        <n-button :disabled="busy" @click="close">关闭工作区（未保存修改不导入）</n-button>
        <n-button type="primary" :disabled="!changed || working" :loading="busy" @click="save"
          >确认保存到当前迭代</n-button
        >
      </n-space></template
    >
  </n-modal>
</template>
