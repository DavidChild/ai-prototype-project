<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { nanoid } from 'nanoid'
import { useWorkbenchStore } from '@/stores/workbench'
import { useSettingsStore } from '@/stores/settings'
import type { GenerationConstraint } from '@/types/generationConstraint'
import { validateConstraint } from '@/prompts/generationConstraints'
import { extractGenerationConstraint } from '@/services/generation/extractGenerationConstraint'

const wb = useWorkbenchStore()
const settings = useSettingsStore()
const message = useMessage()
const dialog = useDialog()
const visible = ref(false)
const draft = ref<GenerationConstraint>({
  id: '',
  name: '',
  description: '',
  html: '',
  updatedAt: 0,
})
const sourceId = ref<string | null>(null)
const target = ref('')
const selector = ref('')
const generating = ref(false)
const saving = ref(false)
const removing = ref(false)
const error = ref('')
const editing = ref(false)
let ownerProjectId = ''
let controller: AbortController | null = null
let sequence = 0
const library = computed(() => wb.project?.generationConstraints ?? [])
const sourceOptions = computed(() =>
  wb.pageRows
    .filter(({ page }) => !page.spec.groupOnly && !!wb.htmlByPage.get(page.id))
    .map(({ page, depth }) => ({
      label: `${'　'.repeat(depth)}${page.spec.name}`,
      value: page.id,
    })),
)

function cancelGeneration() {
  sequence++
  controller?.abort()
  controller = null
  generating.value = false
}
function close() {
  if (saving.value) return
  cancelGeneration()
  visible.value = false
}
function open(item?: GenerationConstraint) {
  if (!wb.project) return
  cancelGeneration()
  ownerProjectId = wb.project.id
  editing.value = !!item
  draft.value = item
    ? (JSON.parse(JSON.stringify(item)) as GenerationConstraint)
    : { id: nanoid(), name: '', description: '', html: '', updatedAt: Date.now() }
  sourceId.value =
    item?.sourcePageId && wb.htmlByPage.has(item.sourcePageId)
      ? item.sourcePageId
      : (sourceOptions.value[0]?.value ?? null)
  target.value = ''
  selector.value = ''
  error.value = ''
  visible.value = true
}
async function generate() {
  if (!visible.value || generating.value || saving.value) return
  error.value = ''
  const project = wb.project
  const source = wb.pages.find((page) => page.id === sourceId.value)
  if (!project || project.id !== ownerProjectId) return
  const name = draft.value.name.trim()
  if (!source || !wb.htmlByPage.get(source.id)) {
    error.value = '请选择有已保存 HTML 的项目页面'
    return
  }
  if (!name || name.length > 100) {
    error.value = '请先填写 1–100 字的约束名称'
    return
  }
  const resolved = settings.resolveModel('generation', project.modelOverride)
  if (!resolved) {
    error.value = '请先在设置中配置生成模型和 API Key'
    return
  }
  const requestId = ++sequence
  const abort = new AbortController()
  controller = abort
  generating.value = true
  try {
    const output = await extractGenerationConstraint({
      name,
      html: wb.htmlByPage.get(source.id)!,
      selector: selector.value,
      instruction: target.value,
      styleSpec: project.styleSpec,
      platform: project.platform,
      ...resolved,
      maxTokens: settings.genParams.maxTokens,
      signal: abort.signal,
    })
    if (requestId !== sequence || wb.project?.id !== ownerProjectId || !visible.value) return
    draft.value = {
      ...draft.value,
      ...output,
      sourcePageId: source.id,
      sourcePageName: source.spec.name,
    }
    message.success('已生成说明和 HTML 片段，请检查后保存')
  } catch (cause) {
    if (requestId === sequence && !abort.signal.aborted)
      error.value = cause instanceof Error ? cause.message : '生成失败，请重试'
  } finally {
    if (requestId === sequence) {
      generating.value = false
      controller = null
    }
  }
}
function requestGenerate() {
  if (draft.value.description || draft.value.html) {
    dialog.warning({
      title: '重新提取约束',
      content: '成功生成后将替换当前草稿中的说明和 HTML，尚未保存的手动修改将被替换。',
      positiveText: '重新生成',
      negativeText: '取消',
      onPositiveClick: () => {
        void generate()
      },
    })
  } else void generate()
}
async function save() {
  if (!visible.value || saving.value || generating.value) return
  error.value = ''
  try {
    validateConstraint(draft.value)
    if (!editing.value && !draft.value.sourcePageId)
      throw new Error('请先选择项目页面并生成约束说明与 HTML')
    saving.value = true
    await wb.saveGlobalConstraint(draft.value, ownerProjectId)
    visible.value = false
    message.success('全局约束已保存，可在各页面信息中选择使用')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败'
  } finally {
    saving.value = false
  }
}
function remove(item: GenerationConstraint) {
  const projectId = wb.project?.id
  if (!projectId || removing.value) return
  dialog.warning({
    title: `删除约束「${item.name}」？`,
    content: '将从全局库中移除；已选用此约束的页面保留独立副本，不受影响。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      removing.value = true
      try {
        await wb.removeGlobalConstraint(item.id, projectId)
        message.success('已删除全局约束')
      } catch (cause) {
        message.error(cause instanceof Error ? cause.message : '删除失败')
      } finally {
        removing.value = false
      }
    },
  })
}
watch(
  () => wb.project?.id,
  () => {
    cancelGeneration()
    visible.value = false
  },
)
onBeforeUnmount(cancelGeneration)
</script>

<template>
  <div class="global-constraints">
    <div class="heading">
      <strong>项目全局约束</strong
      ><n-button size="small" type="primary" :disabled="!wb.project || removing" @click="open()"
        >新增</n-button
      >
    </div>
    <p class="hint">
      从项目 HTML 提取菜单框架、APP 底栏等可复用组件。各页面在“信息”中按需选用，未选用不会传给 AI。
    </p>
    <n-empty
      v-if="!library.length"
      size="small"
      description="还没有全局约束"
      style="margin-top: 28px"
    />
    <n-card v-for="item in library" :key="item.id" size="small" class="constraint-card">
      <strong class="constraint-name">{{ item.name }}</strong>
      <p class="description">{{ item.description }}</p>
      <div class="hint source">
        来源：{{ item.sourcePageName || '自定义 HTML' }} ·
        {{ item.html.length.toLocaleString() }} 字符
      </div>
      <n-space size="small" style="margin-top: 10px">
        <n-button size="tiny" :disabled="removing" @click="open(item)">编辑</n-button>
        <n-button size="tiny" type="error" quaternary :disabled="removing" @click="remove(item)"
          >删除</n-button
        >
      </n-space>
    </n-card>
    <n-modal
      :show="visible"
      preset="card"
      :title="editing ? '编辑全局约束' : '新增全局约束'"
      :mask-closable="false"
      :close-on-esc="!saving"
      :closable="!saving"
      style="width: min(780px, 94vw)"
      @update:show="close"
    >
      <div class="modal-body">
        <n-form label-placement="top" size="small" :disabled="generating || saving">
          <n-form-item label="源 HTML（项目中已保存的页面）"
            ><n-select
              v-model:value="sourceId"
              :options="sourceOptions"
              filterable
              placeholder="选择已有 HTML 的页面"
          /></n-form-item>
          <n-alert v-if="!sourceOptions.length" type="info" style="margin-bottom: 14px"
            >当前项目还没有 HTML，请先生成或导入一个页面。</n-alert
          >
          <n-form-item label="约束名称"
            ><n-input
              v-model:value="draft.name"
              :maxlength="100"
              placeholder="例如：后台菜单框架 / APP 底部导航"
          /></n-form-item>
          <n-form-item label="提取目标（可选）"
            ><n-input
              v-model:value="target"
              type="textarea"
              :rows="2"
              :maxlength="2000"
              placeholder="例如：保留左侧菜单、顶部导航和内容区外壳，不保留业务表格"
          /></n-form-item>
          <n-form-item label="CSS 选择器（可选，缩小提取范围）"
            ><n-input
              v-model:value="selector"
              :maxlength="500"
              placeholder="例如：.sidebar, .topbar；留空时 AI 根据名称提取"
          /></n-form-item>
          <n-space style="margin-bottom: 16px">
            <n-button
              type="primary"
              secondary
              :loading="generating"
              :disabled="generating || saving || !sourceId || !draft.name.trim()"
              @click="requestGenerate"
              >AI 生成约束说明与 HTML</n-button
            >
            <n-button v-if="generating" @click="cancelGeneration">取消生成</n-button>
          </n-space>
          <n-form-item label="约束说明（可修改）"
            ><n-input
              v-model:value="draft.description"
              type="textarea"
              :rows="4"
              :maxlength="5000"
              placeholder="AI 提取后可进一步补充复用要求"
          /></n-form-item>
          <n-form-item
            :label="`HTML 组件片段（${draft.html.length.toLocaleString()} / 30,000 字符）`"
            ><n-input
              v-model:value="draft.html"
              type="textarea"
              :rows="9"
              placeholder="包含组件 DOM 和必要样式，不需要完整页面"
              :input-props="{
                spellcheck: false,
                style: 'font-family: monospace; font-size: 12px',
              }"
          /></n-form-item>
        </n-form>
        <n-alert v-if="error" type="error" style="margin-bottom: 12px">{{ error }}</n-alert>
        <p class="hint">
          仅保存到当前项目迭代的约束库，不会自动启用或覆盖各页面的独立副本。HTML
          仅作为设计数据，不执行。
        </p>
      </div>
      <template #footer
        ><n-space justify="end"
          ><n-button :disabled="saving" @click="close">取消</n-button
          ><n-button type="primary" :loading="saving" :disabled="generating || saving" @click="save"
            >保存约束</n-button
          ></n-space
        ></template
      >
    </n-modal>
  </div>
</template>

<style scoped>
.global-constraints {
  padding: 14px;
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
}
.heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--qp-text-muted);
  overflow-wrap: anywhere;
}
.constraint-card {
  margin-top: 12px;
}
.constraint-name {
  overflow-wrap: anywhere;
}
.description {
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.modal-body {
  max-height: 65vh;
  overflow-y: auto;
  padding-right: 8px;
}
</style>
