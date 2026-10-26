<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { nanoid } from 'nanoid'
import { useMessage } from 'naive-ui'
import { useWorkbenchStore } from '@/stores/workbench'
import type { GenerationConstraint, PageConstraints } from '@/types/generationConstraint'
import {
  buildGenerationConstraints,
  MAX_CONSTRAINTS,
  validateConstraint,
} from '@/prompts/generationConstraints'

const model = defineModel<PageConstraints>()
const props = defineProps<{ disabled?: boolean }>()
const wb = useWorkbenchStore()
const message = useMessage()
const draft = ref<GenerationConstraint | null>(null)
const error = ref('')
const items = computed(() => model.value?.items ?? [])
const mode = computed({
  get: () => model.value?.mode ?? 'none',
  set: (value: 'none' | 'custom') => {
    model.value = { mode: value, items: [...items.value] }
  },
})
const modes = [
  { label: '不使用约束', value: 'none' },
  { label: '使用页面约束', value: 'custom' },
]
const libraryOptions = computed(() =>
  (wb.project?.generationConstraints ?? []).map((item) => ({
    label: item.name,
    value: item.id,
    disabled: items.value.some(
      (selected) => (selected.sourceConstraintId ?? selected.id) === item.id,
    ),
  })),
)
function setItems(value: GenerationConstraint[]) {
  buildGenerationConstraints({ mode: 'custom', items: value })
  model.value = { mode: 'custom', items: value }
}
function addGlobal(id: string | null) {
  if (!id || props.disabled) return
  if (items.value.length >= MAX_CONSTRAINTS) {
    message.warning('每页最多启用 8 个约束')
    return
  }
  const global = wb.project?.generationConstraints?.find((item) => item.id === id)
  if (!global || items.value.some((item) => (item.sourceConstraintId ?? item.id) === id)) return
  const copy = JSON.parse(JSON.stringify(global)) as GenerationConstraint
  try {
    setItems([...items.value, { ...copy, id: nanoid(), sourceConstraintId: id }])
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : '无法添加此约束')
  }
}
function edit(item?: GenerationConstraint) {
  if (props.disabled) return
  error.value = ''
  draft.value = item
    ? (JSON.parse(JSON.stringify(item)) as GenerationConstraint)
    : { id: nanoid(), name: '', description: '', html: '', updatedAt: Date.now() }
}
function apply() {
  if (!draft.value || props.disabled) return
  try {
    validateConstraint(draft.value)
    const index = items.value.findIndex((item) => item.id === draft.value!.id)
    if (index < 0 && items.value.length >= MAX_CONSTRAINTS) throw new Error('每页最多启用 8 个约束')
    const next = [...items.value]
    const item = { ...draft.value, name: draft.value.name.trim(), updatedAt: Date.now() }
    if (index < 0) next.push(item)
    else next[index] = item
    setItems(next)
    draft.value = null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '约束无效'
  }
}
function remove(id: string) {
  if (!props.disabled) setItems(items.value.filter((item) => item.id !== id))
}
watch(
  () => wb.selectedPageId,
  () => {
    draft.value = null
  },
)
</script>

<template>
  <div class="page-constraints">
    <n-select
      v-model:value="mode"
      :options="modes"
      :disabled="disabled"
      aria-label="页面生成约束模式"
    />
    <template v-if="mode === 'custom'">
      <n-select
        :value="null"
        :options="libraryOptions"
        filterable
        :disabled="disabled || items.length >= MAX_CONSTRAINTS"
        placeholder="选择并添加全局约束"
        style="margin-top: 10px"
        aria-label="添加全局约束副本"
        @update:value="addGlobal"
      />
      <n-text v-if="!libraryOptions.length" depth="3" class="hint"
        >还没有全局约束，可点击顶部“全局约束”新增，或添加本页自定义约束。</n-text
      >
      <div v-for="item in items" :key="item.id" class="constraint-item">
        <div class="item-heading">
          <strong>{{ item.name }}</strong
          ><span class="badge">{{ item.sourceConstraintId ? '独立副本' : '本页自定义' }}</span>
        </div>
        <p class="summary">{{ item.description }}</p>
        <n-space size="small">
          <n-button size="tiny" :disabled="disabled" @click="edit(item)">修改说明 / HTML</n-button>
          <n-popconfirm
            :disabled="disabled"
            positive-text="移除"
            negative-text="取消"
            @positive-click="remove(item.id)"
          >
            <template #trigger
              ><n-button size="tiny" type="error" quaternary :disabled="disabled"
                >移除</n-button
              ></template
            >仅从本页移除，不影响全局约束及其他页面。
          </n-popconfirm>
        </n-space>
      </div>
      <n-button
        size="small"
        dashed
        block
        style="margin-top: 10px"
        :disabled="disabled || items.length >= MAX_CONSTRAINTS"
        @click="edit()"
        >添加本页自定义约束（{{ items.length }}/{{ MAX_CONSTRAINTS }}）</n-button
      >
      <n-text depth="3" class="hint"
        >选用后为本页独立副本，可修改或移除。点击下方“保存”后生效，生成时传给
        AI；全局库后续修改不会覆盖本页。</n-text
      >
    </template>
    <n-text v-else depth="3" class="hint"
      >生成时不附带任何页面约束。已配置内容保留，可随时重新启用。</n-text
    >
    <n-modal
      :show="!!draft"
      preset="card"
      title="编辑本页约束"
      :mask-closable="false"
      style="width: min(760px, 94vw)"
      @update:show="draft = null"
    >
      <div v-if="draft" class="modal-body">
        <n-form label-placement="top" size="small" :disabled="disabled">
          <n-form-item label="约束名称"
            ><n-input v-model:value="draft.name" :maxlength="100"
          /></n-form-item>
          <n-form-item label="约束说明"
            ><n-input v-model:value="draft.description" type="textarea" :rows="4" :maxlength="5000"
          /></n-form-item>
          <n-form-item
            :label="`HTML 组件片段（${draft.html.length.toLocaleString()} / 30,000 字符）`"
            ><n-input
              v-model:value="draft.html"
              type="textarea"
              :rows="10"
              :input-props="{
                spellcheck: false,
                style: 'font-family: monospace; font-size: 12px',
              }"
          /></n-form-item>
        </n-form>
        <n-alert v-if="error" type="error">{{ error }}</n-alert>
        <n-text depth="3" class="hint"
          >只修改当前页面，不回写全局库。确认后还需保存页面信息。</n-text
        >
      </div>
      <template #footer
        ><n-space justify="end"
          ><n-button @click="draft = null">取消</n-button
          ><n-button type="primary" :disabled="disabled" @click="apply"
            >应用到本页草稿</n-button
          ></n-space
        ></template
      >
    </n-modal>
  </div>
</template>

<style scoped>
.page-constraints {
  width: 100%;
  min-width: 0;
}
.hint {
  display: block;
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.6;
}
.constraint-item {
  padding: 10px;
  margin-top: 10px;
  border: 1px solid var(--qp-border);
  border-radius: 6px;
}
.item-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.badge {
  font-size: 10px;
  color: var(--qp-text-muted);
}
.summary {
  margin: 8px 0;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.modal-body {
  max-height: 65vh;
  overflow-y: auto;
  padding-right: 8px;
}
</style>
