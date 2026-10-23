<script setup lang="ts">
import { computed, ref } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import type { Page, PageGenStatus } from '@/types/page'
import { useWorkbenchStore } from '@/stores/workbench'
import PageTreeList from './PageTreeList.vue'

const wb = useWorkbenchStore()
const dialog = useDialog()
const message = useMessage()

const addShow = ref(false)
const addName = ref('')
const addParentId = ref<string>('')
const addGroupOnly = ref(false)

const parentOptions = computed(() => [
  { label: '作为一级菜单', value: '' },
  ...wb.pageRows.map(({ page, depth }) => ({
    label: `${'　'.repeat(depth)}${page.spec.name} 下的页面`,
    value: page.spec.id,
  })),
])

const STATUS_META: Record<PageGenStatus, { label: string; color: string }> = {
  idle: { label: '未生成', color: 'rgba(127,127,127,0.45)' },
  queued: { label: '排队中', color: '#f59e0b' },
  generating: { label: '生成中', color: '#6366f1' },
  done: { label: '完成', color: '#22c55e' },
  failed: { label: '失败', color: '#ef4444' },
}

function childrenCount(page: Page): number {
  return wb.pages.filter((p) => p.spec.parentId === page.spec.id).length
}

function confirmRemove(page: Page) {
  if (wb.hierarchySaving || wb.loading) return
  if (childrenCount(page) > 0) {
    message.warning('该菜单下还有下级页面，请先删除或移动它们')
    return
  }
  let removing = false
  const confirmation = dialog.warning({
    title: page.spec.groupOnly ? '删除菜单确认' : '删除页面确认',
    content: `确定删除「${page.spec.name}」吗？${page.spec.groupOnly ? '该导航分组将被删除。' : '页面内容和全部版本历史将一并删除。'}此操作不可恢复。`,
    positiveText: '确认删除',
    negativeText: '取消',
    positiveButtonProps: { type: 'error' },
    maskClosable: false,
    onPositiveClick: async () => {
      if (removing) return false
      if (wb.project?.id !== page.projectId || !wb.pages.some((item) => item.id === page.id)) {
        message.error('项目或页面已切换，请重新选择要删除的页面')
        return false
      }
      removing = true
      confirmation.loading = true
      confirmation.closable = false
      confirmation.closeOnEsc = false
      confirmation.negativeButtonProps = { disabled: true }
      try {
        await wb.removePage(page.id)
        message.success('已删除「' + page.spec.name + '」')
        return true
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败，请重试')
        return false
      } finally {
        removing = false
        confirmation.loading = false
        confirmation.closable = true
        confirmation.closeOnEsc = true
        confirmation.negativeButtonProps = { disabled: false }
      }
    },
  })
}

function submitAdd() {
  const name = addName.value.trim()
  if (!name) return
  void wb.addPage(name, addParentId.value || undefined, addGroupOnly.value)
  addShow.value = false
  addName.value = ''
  addGroupOnly.value = false
}

function openAdd(parentId = '') {
  addParentId.value = parentId
  addGroupOnly.value = false
  addShow.value = true
}
</script>

<template>
  <div class="page-panel">
    <div class="panel-head">
      <n-progress
        type="line"
        :percentage="
          wb.progress.total ? Math.round((wb.progress.done / wb.progress.total) * 100) : 0
        "
        :show-indicator="false"
        :height="4"
      />
      <div class="head-row">
        <n-text depth="3" style="font-size: 12px">
          {{ wb.progress.done }}/{{ wb.progress.total }} 页完成
          <template v-if="wb.progress.active">· {{ wb.progress.active }} 进行中</template>
        </n-text>
        <n-space size="small">
          <n-button
            v-if="wb.progress.failed"
            size="tiny"
            type="warning"
            secondary
            @click="wb.retryFailed()"
          >
            重试失败
          </n-button>
          <n-button v-if="wb.progress.active" size="tiny" secondary @click="wb.cancelAll()">
            全部停止
          </n-button>
          <n-tag
            v-else-if="wb.progress.total > 0 && wb.progress.done === wb.progress.total"
            size="small"
            type="success"
            :bordered="false"
          >
            全部完成
          </n-tag>
          <n-button
            v-else
            size="tiny"
            secondary
            type="primary"
            :disabled="!wb.progress.total"
            @click="
              wb.generatePages(
                wb.pages
                  .filter((p) => p.genStatus !== 'done' && !p.spec.groupOnly)
                  .map((p) => p.id),
              )
            "
          >
            生成未完成
          </n-button>
        </n-space>
      </div>
    </div>

    <n-scrollbar class="panel-body">
      <PageTreeList :status-meta="STATUS_META" @add="openAdd" @remove="confirmRemove" />
    </n-scrollbar>

    <div class="panel-foot">
      <n-button size="small" dashed block @click="openAdd()">+ 新增菜单/页面</n-button>
    </div>

    <n-modal v-model:show="addShow" preset="card" title="新增菜单/页面" style="width: 440px">
      <n-form label-placement="left" label-width="64" size="small">
        <n-form-item label="名称">
          <n-input v-model:value="addName" placeholder="如：会员中心" @keyup.enter="submitAdd" />
        </n-form-item>
        <n-form-item label="层级">
          <n-select v-model:value="addParentId" :options="parentOptions" />
        </n-form-item>
        <n-form-item v-if="!addParentId" label="类型">
          <n-checkbox v-model:checked="addGroupOnly">仅作导航分组，不生成页面</n-checkbox>
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="addShow = false">取消</n-button>
          <n-button type="primary" :disabled="!addName.trim()" @click="submitAdd">添加</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.page-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.panel-head {
  padding: 12px 14px 8px;
}

.head-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  gap: 8px;
}

.panel-body {
  flex: 1;
}

.menu-group {
  padding: 4px 8px;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--qp-text-faint);
  padding: 6px 10px 2px;
  letter-spacing: 0.5px;
}

.page-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.child-item {
  padding-left: 26px;
}

.page-item:hover {
  background: var(--qp-hover);
}

.page-item.active {
  background: rgba(99, 102, 241, 0.16);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-spin {
  flex-shrink: 0;
}

.page-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-actions {
  display: none;
  flex-shrink: 0;
}

.page-item:hover .item-actions,
.group-header:hover .item-actions {
  display: inline-flex;
}

.panel-foot {
  padding: 10px 14px;
  border-top: 1px solid var(--qp-border);
}
</style>
