<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import type { Annotation, AnnotationStore, QualityCheck, QualityCheckInput } from 'web-remarq'
import type { Platform } from '@/types/project'
import { useWorkbenchStore } from '@/stores/workbench'
import { useSettingsStore } from '@/stores/settings'
import {
  buildRemarqPreviewHtml,
  cloneAnnotationStore,
} from '@/services/annotations/remarqDocument'
import {
  checkAnnotationQuality,
  supplementAnnotationFromQuality,
} from '@/services/generation/checkAnnotationQuality'
import {
  generateElementAnnotation,
  generatePageAnnotations,
  type AnnotationCandidate,
  type ExistingAnnotationSummary,
} from '@/services/generation/generateAnnotations'

const props = defineProps<{
  html: string
  platform: Platform
  zoom: number | 'fit'
  previewUrl?: string
  pageId?: string
  annotationMode?: boolean
  annotationStore?: AnnotationStore
}>()
const emit = defineEmits<{
  requestPageAnnotation: []
}>()

const wb = useWorkbenchStore()
const settings = useSettingsStore()
const message = useMessage()
const dialog = useDialog()

function confirmClearAnnotations(): Promise<boolean> {
  return new Promise((resolve) => {
    dialog.warning({
      title: '确认清除当前页标注',
      content: '此操作会清除当前页面所有的原型标注信息，且不可撤销。',
      positiveText: '确认清除',
      negativeText: '取消',
      positiveButtonProps: { type: 'error' },
      closable: false,
      maskClosable: false,
      closeOnEsc: false,
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
    })
  })
}

function newChannel(): string {
  return `qp-remarq-${props.pageId ?? 'page'}-${crypto.randomUUID()}`
}

const annotationChannel = ref(newChannel())
const annotationSeed = ref<AnnotationStore>(cloneAnnotationStore(props.annotationStore))
const annotationFrameReady = ref(false)

const annotatedHtml = computed(() =>
  buildRemarqPreviewHtml(props.html, annotationSeed.value, {
    channel: annotationChannel.value,
    theme: settings.appTheme,
  }),
)

// Only the isolated bridge origin can retain its origin for Layrr's WebSocket.
const isolatedPreview = computed(() => {
  if (props.annotationMode || !props.previewUrl) return ''
  try {
    const url = new URL(props.previewUrl)
    if (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' && url.port &&
      url.origin !== window.location.origin &&
      !url.username && !url.password &&
      /^\/preview\/[a-f0-9]{48}\/$/.test(url.pathname)
    ) return url.href
  } catch {
    // Fall back to the opaque-origin HTML preview.
  }
  return ''
})

const containerEl = ref<HTMLElement | null>(null)
const annotatedFrameEl = ref<HTMLIFrameElement | null>(null)
const containerSize = ref({ w: 800, h: 600 })
let ro: ResizeObserver | null = null
const qualityControllers = new Set<AbortController>()
let commandSequence = 0
const frameRequests = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: number }
>()

function rejectFrameRequests(reason: string) {
  for (const task of frameRequests.values()) {
    clearTimeout(task.timer)
    task.reject(new Error(reason))
  }
  frameRequests.clear()
}

watch(
  () => [props.pageId, props.annotationMode] as const,
  () => {
    rejectFrameRequests('页面或预览模式已切换')
    annotationFrameReady.value = false
    annotationChannel.value = newChannel()
    annotationSeed.value = cloneAnnotationStore(props.annotationStore)
  },
)

async function waitForAnnotationFrame(): Promise<Window> {
  if (!props.annotationMode) throw new Error('请先切换到原型标注模式')
  const startedAt = Date.now()
  while (!annotationFrameReady.value) {
    if (Date.now() - startedAt > 10_000) throw new Error('标注工具尚未加载完成，请刷新后重试')
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  }
  const frameWindow = annotatedFrameEl.value?.contentWindow
  if (!frameWindow) throw new Error('标注画布尚未加载完成')
  return frameWindow
}

async function requestAnnotationFrame<T>(kind: string, payload?: unknown): Promise<T> {
  const frameWindow = await waitForAnnotationFrame()
  const requestId = `host-${++commandSequence}`
  return await new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      frameRequests.delete(requestId)
      reject(new Error('标注工具响应超时，请重试'))
    }, 120_000)
    frameRequests.set(requestId, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    })
    frameWindow.postMessage(
      {
        source: 'quickpage-remarq-host-command',
        channel: annotationChannel.value,
        requestId,
        kind,
        payload,
      },
      '*',
    )
  })
}

function reply(
  target: Window,
  requestId: string,
  response: { ok: true; result?: unknown } | { ok: false; error: string },
) {
  target.postMessage(
    {
      source: 'quickpage-remarq-host',
      channel: annotationChannel.value,
      requestId,
      ...response,
    },
    '*',
  )
}

async function handleRemarqMessage(event: MessageEvent) {
  const frameWindow = annotatedFrameEl.value?.contentWindow
  const data = event.data as {
    source?: string
    channel?: string
    requestId?: string
    kind?: string
    payload?: unknown
  }
  if (
    !frameWindow ||
    event.source !== frameWindow ||
    data.channel !== annotationChannel.value
  )
    return
  if (data.source === 'quickpage-remarq-ready') {
    annotationFrameReady.value = true
    return
  }
  if (data.source === 'quickpage-remarq-command-result' && data.requestId) {
    const task = frameRequests.get(data.requestId)
    if (!task) return
    clearTimeout(task.timer)
    frameRequests.delete(data.requestId)
    const response = data as typeof data & { ok?: boolean; result?: unknown; error?: string }
    if (response.ok) task.resolve(response.result)
    else task.reject(new Error(response.error || '标注操作失败'))
    return
  }
  if (data.source !== 'quickpage-remarq' || !data.requestId) return
  try {
    if (data.kind === 'annotatePage') {
      emit('requestPageAnnotation')
      reply(frameWindow, data.requestId, { ok: true })
      return
    }
    if (data.kind === 'confirmClear') {
      const confirmed = await confirmClearAnnotations()
      reply(frameWindow, data.requestId, { ok: true, result: confirmed })
      return
    }
    if (data.kind === 'generateElementDraft') {
      const input = data.payload as {
        candidate: AnnotationCandidate
        existingAnnotations: ExistingAnnotationSummary[]
        directions?: string[]
        instruction?: string
      }
      const context = aiContext(input.existingAnnotations)
      const controller = new AbortController()
      qualityControllers.add(controller)
      try {
        const comment = await generateElementAnnotation({
          ...context,
          candidate: input.candidate,
          directions: input.directions,
          instruction: input.instruction,
          signal: controller.signal,
        })
        assertSamePage(context.projectId, context.pageId)
        reply(frameWindow, data.requestId, { ok: true, result: comment })
      } finally {
        qualityControllers.delete(controller)
      }
      return
    }
    if (data.kind === 'store') {
      if (!props.pageId) throw new Error('页面标识缺失')
      await wb.savePageAnnotations(props.pageId, data.payload as AnnotationStore)
      reply(frameWindow, data.requestId, { ok: true })
      return
    }
    if (data.kind === 'quality') {
      const page = wb.pages.find((candidate) => candidate.id === props.pageId)
      const project = wb.project
      const resolved = settings.resolveModel('generation', project?.modelOverride)
      if (!page || !project || !resolved) throw new Error('请先配置可用的生成模型')
      const controller = new AbortController()
      qualityControllers.add(controller)
      try {
        const result = await checkAnnotationQuality({
          ...resolved,
          projectName: project.name,
          projectOverview: project.analysis?.overview,
          pageName: page.spec.name,
          pageDescription: page.spec.description,
          annotation: data.payload as QualityCheckInput,
          signal: controller.signal,
        })
        if (wb.project?.id !== project.id || wb.selectedPageId !== page.id)
          throw new Error('页面已切换')
        reply(frameWindow, data.requestId, { ok: true, result })
      } finally {
        qualityControllers.delete(controller)
      }
      return
    }
    if (data.kind === 'supplementQuality') {
      const page = wb.pages.find((candidate) => candidate.id === props.pageId)
      const project = wb.project
      const resolved = settings.resolveModel('generation', project?.modelOverride)
      if (!page || !project || !resolved) throw new Error('请先配置可用的生成模型')
      const payload = data.payload as {
        annotation: QualityCheckInput
        qualityCheck: QualityCheck
      }
      const controller = new AbortController()
      qualityControllers.add(controller)
      try {
        const result = await supplementAnnotationFromQuality({
          ...resolved,
          projectName: project.name,
          projectOverview: project.analysis?.overview,
          pageName: page.spec.name,
          pageDescription: page.spec.description,
          annotation: payload.annotation,
          qualityCheck: payload.qualityCheck,
          signal: controller.signal,
        })
        if (wb.project?.id !== project.id || wb.selectedPageId !== page.id)
          throw new Error('页面已切换')
        reply(frameWindow, data.requestId, { ok: true, result })
      } finally {
        qualityControllers.delete(controller)
      }
      return
    }
    throw new Error('未知的标注操作')
  } catch (error) {
    const detail = error instanceof Error ? error.message : '标注操作失败'
    if (data.kind === 'store') message.error(detail)
    reply(frameWindow, data.requestId, { ok: false, error: detail })
  }
}

interface FrameSnapshot {
  candidates: AnnotationCandidate[]
  existingAnnotations: ExistingAnnotationSummary[]
}

interface PickedElement extends FrameSnapshot {
  candidate: AnnotationCandidate
  existingComment?: string
}

function aiContext(existingAnnotations: ExistingAnnotationSummary[]) {
  const page = wb.pages.find((candidate) => candidate.id === props.pageId)
  const project = wb.project
  const resolved = settings.resolveModel('generation', project?.modelOverride)
  if (!page || !project) throw new Error('页面已切换，请重新操作')
  if (!resolved) throw new Error('请先在设置中配置可用的生成模型')
  return {
    ...resolved,
    projectName: project.name,
    projectOverview: project.analysis?.overview,
    pageName: page.spec.name,
    pageDescription: page.spec.description,
    platform: project.platform,
    existingAnnotations,
    pageId: page.id,
    projectId: project.id,
  }
}

function buildAIAnnotation(candidate: AnnotationCandidate, comment: string): Annotation {
  const now = Date.now()
  return {
    id: `ann-ai-${now}-${Math.random().toString(36).slice(2, 8)}`,
    comment,
    fingerprint: candidate.fingerprint,
    route: candidate.route,
    viewport: `${candidate.viewport.width}x${candidate.viewport.height}`,
    viewportBucket: Math.floor(candidate.viewport.width / 100) * 100,
    timestamp: now,
    status: 'pending',
    lifecycle: [{ type: 'created', actor: 'agent', actorName: 'AI 标注', timestamp: now }],
  }
}

function assertSamePage(projectId: string, pageId: string) {
  if (wb.project?.id !== projectId || wb.selectedPageId !== pageId)
    throw new Error('页面已切换，本次 AI 标注未写入')
}

async function generateCurrentPageAnnotations(input: {
  directions: string[]
  instruction?: string
}): Promise<number> {
  const snapshot = await requestAnnotationFrame<FrameSnapshot>('scan')
  const context = aiContext(snapshot.existingAnnotations)
  const controller = new AbortController()
  qualityControllers.add(controller)
  try {
    const generated = await generatePageAnnotations({
      ...context,
      candidates: snapshot.candidates,
      directions: input.directions,
      instruction: input.instruction,
      signal: controller.signal,
    })
    assertSamePage(context.projectId, context.pageId)
    const result = await requestAnnotationFrame<{ added: number }>('append', {
      annotations: generated.map(({ candidate, comment }) =>
        buildAIAnnotation(candidate, comment),
      ),
    })
    return result.added
  } finally {
    qualityControllers.delete(controller)
  }
}

async function generateSelectedElementAnnotation(): Promise<number> {
  const picked = await requestAnnotationFrame<PickedElement>('pick')
  if (picked.existingComment)
    throw new Error(`该元素已有标注：${picked.existingComment.slice(0, 80)}`)
  const context = aiContext(picked.existingAnnotations)
  const controller = new AbortController()
  qualityControllers.add(controller)
  try {
    const comment = await generateElementAnnotation({
      ...context,
      candidate: picked.candidate,
      signal: controller.signal,
    })
    assertSamePage(context.projectId, context.pageId)
    const result = await requestAnnotationFrame<{ added: number }>('append', {
      annotations: [buildAIAnnotation(picked.candidate, comment)],
    })
    return result.added
  } finally {
    qualityControllers.delete(controller)
  }
}

defineExpose({ generateCurrentPageAnnotations, generateSelectedElementAnnotation })

onMounted(() => {
  ro = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect
    if (rect) containerSize.value = { w: rect.width, h: rect.height }
  })
  if (containerEl.value) ro.observe(containerEl.value)
  window.addEventListener('message', handleRemarqMessage)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener('message', handleRemarqMessage)
  rejectFrameRequests('标注画布已关闭')
  for (const controller of qualityControllers) controller.abort()
})

const base = computed(() =>
  props.platform === 'pc' ? { w: 1440, h: 900 } : { w: 375, h: 812 },
)

const scale = computed(() => {
  if (props.zoom !== 'fit') return props.zoom
  const pad = 40
  const s = Math.min(
    (containerSize.value.w - pad) / base.value.w,
    (containerSize.value.h - pad) / base.value.h,
  )
  return Math.min(1, Math.max(0.08, s))
})
</script>

<template>
  <div ref="containerEl" class="frame-container">
    <div
      class="frame-outer"
      :class="{ phone: platform === 'mobile' }"
      :style="{ width: base.w * scale + 'px', height: base.h * scale + 'px' }"
    >
      <iframe
        v-if="isolatedPreview"
        class="frame"
        title="AI 工作区原型预览"
        sandbox="allow-scripts allow-same-origin"
        referrerpolicy="no-referrer"
        :src="isolatedPreview"
        :style="{
          width: base.w + 'px',
          height: base.h + 'px',
          transform: `scale(${scale})`,
        }"
      />
      <iframe
        v-else
        ref="annotatedFrameEl"
        class="frame"
        :title="annotationMode ? '带标注原型预览' : '原型预览'"
        sandbox="allow-scripts allow-downloads"
        :srcdoc="annotationMode ? annotatedHtml : html"
        :style="{
          width: base.w + 'px',
          height: base.h + 'px',
          transform: `scale(${scale})`,
        }"
      />
    </div>
  </div>
</template>

<style scoped>
.frame-container {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
}

.frame-outer {
  position: relative;
  overflow: hidden;
  border-radius: 6px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.45);
  background: #fff;
  flex-shrink: 0;
}

.frame-outer.phone {
  border-radius: 18px;
  outline: 6px solid #2a2a30;
}

.frame {
  border: 0;
  transform-origin: top left;
  display: block;
  background: #fff;
}
</style>
