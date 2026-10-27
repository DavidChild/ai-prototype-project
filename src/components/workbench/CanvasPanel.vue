<script setup lang="ts">
import { ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useWorkbenchStore } from '@/stores/workbench'
import { ANNOTATION_DIRECTION_OPTIONS } from '@/services/annotations/annotationDirections'
import SandboxFrame from './SandboxFrame.vue'
import StreamingCodePane from './StreamingCodePane.vue'
import LayrrEditor from './LayrrEditor.vue'

const wb = useWorkbenchStore()
const dialog = useDialog()
const message = useMessage()

const zoom = ref<number | 'fit'>('fit')
const previewMode = ref<'prototype' | 'annotations'>('annotations')
const aiPreviewUrl = ref('')
const aiWorkspaceError = ref('')
const sandboxFrameEl = ref<InstanceType<typeof SandboxFrame> | null>(null)
const annotationDialogVisible = ref(false)
const annotatingPage = ref(false)
const annotationInstruction = ref('')
const annotationDirectionOptions = ANNOTATION_DIRECTION_OPTIONS
const annotationDirections = ref<string[]>(
  annotationDirectionOptions.map((option) => option.value),
)
const zoomOptions = [
  { label: '适应', value: 'fit' },
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: '100%', value: 1 },
]

const liveHtml = ref('')
const generationErrorDismissed = ref(false)
const dismissedGenerationErrors = new Set<string>()
let throttleTimer: number | undefined

function requestRegenerate() {
  if (!wb.selectedPage) return
  if (!wb.selectedHtml) {
    wb.regenerateSelected()
    return
  }
  dialog.warning({
    title: '确认重新生成',
    content: '重新生成会覆盖当前页面现有的 AI 原型内容，但不会删除页面配置和历史版本。是否继续？',
    positiveText: '继续生成',
    negativeText: '取消',
    onPositiveClick: () => wb.regenerateSelected(),
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'AI 标注失败，请重试'
}

async function annotateCurrentPage() {
  if (annotatingPage.value) return
  const frame = sandboxFrameEl.value
  if (!frame) return
  annotatingPage.value = true
  try {
    const added = await frame.generateCurrentPageAnnotations({
      directions: annotationDirections.value,
      instruction: annotationInstruction.value,
    })
    annotationDialogVisible.value = false
    message.success(added ? `已生成 ${added} 条当前页标注` : '当前页没有新增标注')
  } catch (error) {
    message.error(errorMessage(error), { duration: 5000 })
  } finally {
    annotatingPage.value = false
  }
}

function openPageAnnotationDialog() {
  if (annotatingPage.value) return
  annotationDialogVisible.value = true
}

function generationErrorKey() {
  const page = wb.selectedPage
  return page?.genStatus === 'failed' && page.errorMessage
    ? `${page.id}:${page.errorMessage}`
    : ''
}

watch(
  () => ({
    pageId: wb.selectedPageId ?? '',
    status: wb.selectedPage?.genStatus ?? '',
    error: wb.selectedPage?.errorMessage ?? '',
  }),
  (state, previous) => {
    if (previous.pageId === state.pageId && previous.status === 'failed' && state.status !== 'failed') {
      dismissedGenerationErrors.delete(`${previous.pageId}:${previous.error}`)
    }
    const key = generationErrorKey()
    generationErrorDismissed.value = !!key && dismissedGenerationErrors.has(key)
  },
)

function dismissGenerationError() {
  const key = generationErrorKey()
  if (key) dismissedGenerationErrors.add(key)
  generationErrorDismissed.value = true
}

watch(
  () => wb.selectedStream?.text ?? '',
  (text) => {
    if (!text) {
      liveHtml.value = ''
      if (throttleTimer) {
        clearTimeout(throttleTimer)
        throttleTimer = undefined
      }
      return
    }
    if (throttleTimer) return
    throttleTimer = window.setTimeout(() => {
      throttleTimer = undefined
      liveHtml.value = wb.selectedStream?.text ?? ''
    }, 1500)
  },
)

watch(
  () => wb.selectedPageId,
  () => {
    liveHtml.value = ''
  },
)

watch(previewMode, (mode) => {
  if (mode === 'annotations') {
    aiPreviewUrl.value = ''
    aiWorkspaceError.value = ''
  }
})
</script>

<template>
  <div class="canvas-panel">
    <div class="toolbar">
      <span class="workspace-title">AI 工作区</span>
      <span class="page-title">{{ wb.selectedPage?.spec.name ?? '未选择页面' }}</span>
      <n-radio-group
        v-model:value="previewMode"
        size="tiny"
        :disabled="!wb.selectedHtml || !!wb.selectedPage?.spec.groupOnly"
        aria-label="原型设计模式"
      >
        <n-radio-button value="prototype" title="不显示原型标注">原型设计</n-radio-button>
        <n-radio-button value="annotations" title="使用 web-remarq 查看和编辑原型标注">
          原型标注
          <template v-if="wb.selectedPage?.annotationStore?.annotations.length">
            ({{ wb.selectedPage.annotationStore.annotations.length }})
          </template>
        </n-radio-button>
      </n-radio-group>
      <n-select
        :value="zoom"
        :options="zoomOptions"
        size="tiny"
        style="width: 90px"
        @update:value="(v: number | 'fit') => (zoom = v)"
      />
      <div style="flex: 1" />
      <LayrrEditor
        v-if="previewMode === 'prototype'"
        @preview="(url) => (aiPreviewUrl = url)"
        @error="(error) => (aiWorkspaceError = error)"
      />
      <template v-if="wb.selectedPage && !wb.selectedPage.spec.groupOnly">
        <n-button
          v-if="
            wb.selectedPage.genStatus === 'generating' || wb.selectedPage.genStatus === 'queued'
          "
          size="tiny"
          secondary
          @click="wb.cancelPage(wb.selectedPage.id)"
        >
          取消生成
        </n-button>
        <n-button
          v-else
          size="tiny"
          secondary
          type="primary"
          :disabled="wb.localEditingPageId === wb.selectedPage.id || wb.refining"
          @click="requestRegenerate"
        >
          {{ wb.selectedHtml ? '重新生成' : '生成' }}
        </n-button>
      </template>
    </div>

    <n-modal
      v-model:show="annotationDialogVisible"
      preset="card"
      title="AI 标注当前页"
      :mask-closable="!annotatingPage"
      :closable="!annotatingPage"
      style="width: min(680px, 94vw)"
    >
      <div class="annotation-config">
        <div>
          <div class="annotation-config-title">重点标注方向</div>
          <n-text depth="3" class="annotation-config-hint">
            AI 会结合项目背景和页面内容，只标注界面本身无法说明的关键业务规则。
          </n-text>
        </div>
        <n-checkbox-group v-model:value="annotationDirections">
          <div class="annotation-direction-grid">
            <n-checkbox
              v-for="option in annotationDirectionOptions"
              :key="option.value"
              :value="option.value"
              :label="option.label"
            />
          </div>
        </n-checkbox-group>
        <div>
          <div class="annotation-config-title">补充要求</div>
          <n-input
            v-model:value="annotationInstruction"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 6 }"
            maxlength="1000"
            show-count
            placeholder="例如：重点说明会员推荐出现的条件、每天展示次数，以及关闭后何时再次出现"
          />
        </div>
      </div>
      <template #footer>
        <div class="annotation-dialog-actions">
          <n-button :disabled="annotatingPage" @click="annotationDialogVisible = false">
            取消
          </n-button>
          <n-button
            type="primary"
            :loading="annotatingPage"
            :disabled="!annotationDirections.length && !annotationInstruction.trim()"
            @click="annotateCurrentPage"
          >
            生成标注
          </n-button>
        </div>
      </template>
    </n-modal>

    <div class="canvas-body">
      <template v-if="!wb.selectedPage">
        <n-empty description="左侧选择一个页面" class="center" />
      </template>

      <template v-else-if="wb.selectedPage.spec.groupOnly">
        <n-empty description="这是导航分组节点，不生成页面" class="center" />
      </template>

      <template v-else-if="wb.selectedPage.genStatus === 'generating' && wb.selectedStream">
        <div class="generating-split">
          <div class="live-preview">
            <SandboxFrame
              v-if="liveHtml && wb.selectedPage.spec.generationMode !== 'smart-related'"
              :html="liveHtml"
              :platform="wb.project!.platform"
              :zoom="zoom"
            />
            <n-empty
              v-else
              :description="
                wb.selectedPage.spec.generationMode === 'smart-related'
                  ? 'AI 正在分析当前页与关联页面…'
                  : '正在等待模型输出…'
              "
              class="center"
            />
          </div>
          <div class="live-code">
            <StreamingCodePane :stream="wb.selectedStream" />
          </div>
        </div>
      </template>

      <template v-else-if="wb.selectedPage.genStatus === 'queued'">
        <n-empty description="排队等待生成…" class="center" />
      </template>

      <template v-else-if="wb.selectedPage.genStatus === 'failed' && !wb.selectedHtml">
        <div class="center">
          <n-result status="error" title="生成失败" :description="wb.selectedPage.errorMessage">
            <template #footer>
              <n-button type="primary" @click="requestRegenerate">重试</n-button>
            </template>
          </n-result>
        </div>
      </template>

      <template v-else-if="wb.selectedHtml">
        <n-alert
          v-if="aiWorkspaceError"
          type="warning"
          :bordered="false"
          style="margin: 8px 12px 0"
        >
          {{ aiWorkspaceError }}
        </n-alert>
        <n-alert
          v-if="wb.selectedPage.genStatus === 'failed' && !generationErrorDismissed"
          type="warning"
          :bordered="false"
          closable
          style="margin: 8px 12px 0"
          @close="dismissGenerationError"
        >
          上次生成失败：{{ wb.selectedPage.errorMessage }}（当前展示历史版本）
        </n-alert>
        <SandboxFrame
          ref="sandboxFrameEl"
          :html="wb.selectedHtml"
          :preview-url="aiPreviewUrl"
          :platform="wb.project!.platform"
          :zoom="zoom"
          :page-id="wb.selectedPage.id"
          :annotation-mode="previewMode === 'annotations'"
          :annotation-store="wb.selectedPage.annotationStore"
          @request-page-annotation="openPageAnnotationDialog"
        />
      </template>

      <template v-else>
        <div class="center">
          <n-empty description="该页面还未生成">
            <template #extra>
              <n-button type="primary" @click="wb.regenerateSelected()">立即生成</n-button>
            </template>
          </n-empty>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.canvas-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--qp-border);
}

.page-title {
  font-size: 13px;
  font-weight: 600;
}

.workspace-title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.canvas-body {
  flex: 1;
  min-height: 0;
  position: relative;
  background:
    radial-gradient(var(--qp-canvas-dot) 1px, transparent 1px) 0 0 / 22px 22px,
    var(--qp-canvas-bg);
  display: flex;
  flex-direction: column;
}

.annotation-config {
  display: grid;
  gap: 18px;
}

.annotation-config-title {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
}

.annotation-config-hint {
  display: block;
  font-size: 12px;
  line-height: 1.6;
}

.annotation-direction-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 14px;
}

.annotation-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 760px) {
  .annotation-direction-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.generating-split {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}

.live-preview {
  flex: 1.4;
  min-height: 0;
  display: flex;
}

.live-code {
  flex: 1;
  min-height: 0;
}
</style>
