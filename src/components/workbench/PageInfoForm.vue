<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import type { PageSpec } from '@/types/analysis'
import { useWorkbenchStore } from '@/stores/workbench'
import { pageSubtreeIds } from '@/utils/pageTree'
import { pageTypeLockReason } from '@/utils/pageEditing'

const wb = useWorkbenchStore()
const message = useMessage()

const form = reactive<PageSpec>({ id: '', name: '', description: '', blocks: [] })
const parentChoice = ref('')
const typeLockReason = computed(() =>
  wb.selectedPage ? pageTypeLockReason(wb.selectedPage, !!wb.selectedHtml) : '',
)

watch(
  () => wb.selectedPage?.spec,
  (spec) => {
    if (!spec) return
    Object.assign(form, JSON.parse(JSON.stringify(spec)) as PageSpec)
    form.parentId = spec.parentId
    form.groupOnly = spec.groupOnly
    parentChoice.value = spec.parentId ?? ''
  },
  { immediate: true },
)

const parentOptions = computed(() => {
  const excluded = pageSubtreeIds(wb.pages, wb.selectedPageId ?? '')
  return [
    { label: '一级菜单（无上级）', value: '' },
    ...wb.pageRows
      .filter(({ page }) => !excluded.has(page.spec.id))
      .map(({ page, depth }) => ({
        label: `${'　'.repeat(depth)}${page.spec.name}`,
        value: page.spec.id,
      })),
  ]
})

function specKey(s: PageSpec): string {
  return JSON.stringify([s.name, s.parentId ?? '', !!s.groupOnly, s.description, s.blocks])
}

const dirty = computed(() => {
  const spec = wb.selectedPage?.spec
  if (!spec) return false
  return specKey(spec) !== specKey({ ...form, parentId: parentChoice.value || undefined })
})

async function save(regenerate: boolean) {
  if (!form.name.trim()) {
    message.error('页面名不能为空')
    return
  }
  const spec: PageSpec = JSON.parse(
    JSON.stringify({ ...form, parentId: parentChoice.value || undefined }),
  ) as PageSpec
  try {
    await wb.updateSelectedSpec(spec)
    message.success('已保存')
    if (regenerate && !spec.groupOnly) wb.regenerateSelected()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存失败，请重试')
  }
}
</script>

<template>
  <div class="page-info">
    <n-empty
      v-if="!wb.selectedPage"
      size="small"
      description="未选择页面"
      style="margin-top: 40px"
    />
    <template v-else>
      <n-form label-placement="top" size="small">
        <n-form-item label="页面名称">
          <n-input v-model:value="form.name" />
        </n-form-item>
        <n-form-item label="菜单层级">
          <n-space vertical size="small" style="width: 100%">
            <n-select
              v-model:value="parentChoice"
              :options="parentOptions"
              :disabled="wb.hierarchySaving"
            />
            <n-text depth="3" style="font-size: 11px">
              调整菜单层级时，全部下级页面会一起移动
            </n-text>
          </n-space>
        </n-form-item>
        <n-form-item label="菜单类型">
          <n-space vertical size="small">
            <n-checkbox
              v-model:checked="form.groupOnly"
              :disabled="!!typeLockReason || wb.hierarchySaving"
            >
              仅作导航分组，不生成页面
            </n-checkbox>
            <n-text depth="3" style="font-size: 11px">
              {{ typeLockReason || '勾选后仅作为菜单，保留下级页面，不生成独立页面' }}
            </n-text>
          </n-space>
        </n-form-item>
        <n-form-item label="页面描述">
          <n-input v-model:value="form.description" type="textarea" :rows="3" />
        </n-form-item>
        <n-form-item label="内容区块（从上到下）">
          <n-dynamic-tags v-model:value="form.blocks" />
        </n-form-item>
      </n-form>
      <n-space vertical size="small">
        <n-button size="small" block :disabled="!dirty" @click="save(false)">保存</n-button>
        <n-button
          size="small"
          block
          type="primary"
          secondary
          :disabled="!!form.groupOnly"
          @click="save(true)"
        >
          保存并重新生成
        </n-button>
        <n-text depth="3" style="font-size: 11px">{{
          form.groupOnly
            ? '导航分组不生成页面，点击保存即可生效'
            : '修改页面信息后需重新生成才会体现在设计图中'
        }}</n-text>
      </n-space>
    </template>
  </div>
</template>

<style scoped>
.page-info {
  padding: 14px;
  height: 100%;
  overflow: auto;
}
</style>
