<script setup lang="ts">
import { computed } from 'vue'
import {
  DEFAULT_PAGE_IMPORT_MODIFICATION_RULES,
  type PageImportModificationRules,
} from '@/types/analysis'

const props = defineProps<{
  modelValue?: PageImportModificationRules
  disabled?: boolean
  forNewPage?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: PageImportModificationRules]
}>()

const rules = computed(() => ({ ...DEFAULT_PAGE_IMPORT_MODIFICATION_RULES, ...props.modelValue }))

function update<K extends keyof PageImportModificationRules>(
  key: K,
  value: PageImportModificationRules[K],
) {
  emit('update:modelValue', { ...rules.value, [key]: value })
}

const selectedCount = computed(
  () =>
    [
      rules.value.onlyExtendExisting,
      rules.value.allowOverlays,
      rules.value.allowContentChanges,
      rules.value.allowStyleChanges,
      rules.value.allowNewSections,
      rules.value.allowDeleteSections,
    ].filter(Boolean).length,
)
</script>

<template>
  <n-popover trigger="click" placement="bottom-start" :disabled="disabled">
    <template #trigger>
      <n-button
        size="tiny"
        quaternary
        type="warning"
        :disabled="disabled"
        :title="`${props.forNewPage ? '新页面' : '引入页'}已配置 ${selectedCount} 项修改规则`"
      >
        {{ props.forNewPage ? '新页限制' : '限制' }} {{ selectedCount }}
      </n-button>
    </template>
    <div class="rules-editor">
      <div class="rules-title">{{ props.forNewPage ? '基于引入页生成的新页限制' : '允许修改范围' }}</div>
      <n-alert type="warning" :show-icon="false">
        框架和导航结构是强制保护项，不能取消。AI 只能在下面勾选范围内扩展{{ props.forNewPage ? '新页面' : '此引入页' }}。
      </n-alert>
      <div class="rules-list">
        <n-checkbox :checked="rules.preserveFramework" disabled>
          保留现有页面框架与 DOM 结构
        </n-checkbox>
        <n-checkbox :checked="rules.preserveNavigation" disabled>
          保留现有菜单、导航和页面层级
        </n-checkbox>
        <n-checkbox
          :checked="rules.onlyExtendExisting"
          @update:checked="update('onlyExtendExisting', $event)"
        >
          完全基于现有内容上扩展，不整体替换页面
        </n-checkbox>
        <n-checkbox
          :checked="rules.allowOverlays"
          @update:checked="update('allowOverlays', $event)"
        >
          允许新增弹窗、抽屉、提示层或引导层
        </n-checkbox>
        <n-checkbox
          :checked="rules.allowContentChanges"
          @update:checked="update('allowContentChanges', $event)"
        >
          允许修改现有文案和示例数据
        </n-checkbox>
        <n-checkbox
          :checked="rules.allowStyleChanges"
          @update:checked="update('allowStyleChanges', $event)"
        >
          允许调整样式、间距和排版，不改变框架
        </n-checkbox>
        <n-checkbox
          :checked="rules.allowNewSections"
          @update:checked="update('allowNewSections', $event)"
        >
          允许在现有框架内追加业务区块
        </n-checkbox>
        <n-checkbox
          :checked="rules.allowDeleteSections"
          @update:checked="update('allowDeleteSections', $event)"
        >
          允许删除现有业务区块（谨慎开启）
        </n-checkbox>
      </div>
      <n-input
        :value="rules.requirements"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 5 }"
        maxlength="2000"
        show-count
        placeholder="补充限制要求，例如：只能在列表下方追加引导弹窗，不得改动登录流程。"
        @update:value="update('requirements', $event)"
      />
    </div>
  </n-popover>
</template>

<style scoped>
.rules-editor {
  width: min(380px, calc(100vw - 40px));
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rules-title {
  font-size: 13px;
  font-weight: 600;
}

.rules-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
</style>
