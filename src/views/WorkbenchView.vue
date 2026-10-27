<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { projectRepo } from '@/services/storage/repositories'
import { useIterationSelectionStore } from '@/stores/iterationSelection'
import { useRoute, useRouter } from 'vue-router'
import { useWorkbenchStore } from '@/stores/workbench'
import { useSettingsStore } from '@/stores/settings'
import { getStylePreset } from '@/data/stylePresets'
import PagePanel from '@/components/workbench/PagePanel.vue'
import ResizablePageSidebar from '@/components/workbench/ResizablePageSidebar.vue'
import ResizableInspectorPanel from '@/components/workbench/ResizableInspectorPanel.vue'
import CanvasPanel from '@/components/workbench/CanvasPanel.vue'
import RefineChat from '@/components/workbench/RefineChat.vue'
import VersionList from '@/components/workbench/VersionList.vue'
import PageInfoForm from '@/components/workbench/PageInfoForm.vue'
import GlobalConstraints from '@/components/workbench/GlobalConstraints.vue'
import ExportMenu from '@/components/workbench/ExportMenu.vue'
import ShareMenu from '@/components/workbench/ShareMenu.vue'
import ModelSelect from '@/components/settings/ModelSelect.vue'
import { useAuthStore } from '@/stores/auth'
import AccountSettingsDialog from '@/components/account/AccountSettingsDialog.vue'

const route = useRoute()
const router = useRouter()
const wb = useWorkbenchStore()
const settings = useSettingsStore()
const auth = useAuthStore()
const accountSettingsShow = ref(false)
const iterationSelection = useIterationSelectionStore()
const iterationOptions = ref<{ label: string; value: string }[]>([])
const showGlobalConstraints = ref(false)
const dialog = useDialog()
const message = useMessage()
watch(
  () => wb.project?.id,
  async (id) => {
    const project = wb.project
    showGlobalConstraints.value = false
    iterationOptions.value = []
    if (!project || !id) return
    iterationSelection.select(project.familyId ?? id, id)
    try {
      const all = await projectRepo.list()
      if (wb.project?.id !== id) return
      iterationOptions.value = all
        .filter((p) => (p.familyId ?? p.id) === (project.familyId ?? id))
        .map((p) => ({ label: p.iteration ?? 'v1.0', value: p.id }))
    } catch {
      message.error('版本列表加载失败，请刷新重试')
    }
  },
  { immediate: true },
)
function switchIteration(id: string) {
  if (id === wb.project?.id || !iterationOptions.value.some((option) => option.value === id)) return
  const navigate = () => router.push(`/project/${id}`)
  dialog.warning({
    title: '切换项目版本',
    content: '切换将丢弃尚未保存的表单内容，并停止当前生成和微调。已保存的数据不受影响。',
    positiveText: '切换',
    negativeText: '取消',
    onPositiveClick: navigate,
  })
}

function loadFromRoute() {
  const id = route.params.id as string
  if (!id) return
  const autostart = route.query.autostart === '1'
  if (autostart) void router.replace({ path: route.path })
  void wb.load(id, autostart)
}

onMounted(loadFromRoute)
watch(
  () => route.params.id,
  () => {
    if (route.name === 'workbench') loadFromRoute()
  },
)
</script>

<template>
  <div class="workbench">
    <header class="topbar">
      <n-button quaternary size="small" @click="router.push('/')">← 项目</n-button>
      <span class="project-name">{{ wb.project?.name ?? '加载中…' }}</span>
      <n-select
        v-if="wb.project"
        :value="wb.project.id"
        :options="iterationOptions"
        size="tiny"
        style="width: 110px; flex-shrink: 0"
        aria-label="切换项目迭代版本"
        :disabled="wb.loading || wb.hierarchySaving"
        @update:value="switchIteration"
      />
      <n-tag v-if="wb.project" size="small" :bordered="false">
        {{ wb.project.platform === 'pc' ? 'PC Web' : '移动端 H5' }}
      </n-tag>
      <n-tag v-if="wb.project" size="small" :bordered="false">
        {{ getStylePreset(wb.project.styleSpec.presetId)?.name ?? '自定义风格' }}
        <span class="style-dot" :style="{ background: wb.project.styleSpec.tokens.primaryColor }" />
      </n-tag>
      <n-button
        v-if="auth.canEdit"
        size="small"
        secondary
        :disabled="!wb.project || wb.loading || !!wb.loadError"
        style="flex-shrink: 0"
        @click="showGlobalConstraints = true"
      >
        全局约束
      </n-button>
      <div style="flex: 1" />
      <div v-if="auth.canEdit" class="topbar-model">
        <n-text depth="3" style="font-size: 12px; flex-shrink: 0">生成模型</n-text>
        <ModelSelect v-model="settings.modelSelection.generation" size="tiny" style="flex: 1" />
      </div>
      <ExportMenu />
      <ShareMenu v-if="auth.canEdit" />
      <n-button
        size="small"
        quaternary
        :title="settings.appTheme === 'dark' ? '切换到浅色' : '切换到深色'"
        @click="settings.toggleAppTheme()"
      >
        {{ settings.appTheme === 'dark' ? '🌙' : '☀️' }}
      </n-button>
      <n-tag v-if="auth.isReviewer" type="info" :bordered="false">审阅只读</n-tag>
      <n-button size="small" quaternary @click="accountSettingsShow = true">账号</n-button>
      <n-button v-if="auth.isAdmin" size="small" quaternary @click="router.push('/settings')">模型设置</n-button>
    </header>

    <AccountSettingsDialog v-model:show="accountSettingsShow" />
    <n-modal
      v-model:show="showGlobalConstraints"
      preset="card"
      title="全局约束"
      :mask-closable="false"
      style="width: min(860px, 94vw)"
    >
      <div class="global-constraints-panel">
        <GlobalConstraints v-if="showGlobalConstraints && wb.project" :key="wb.project.id" />
      </div>
    </n-modal>

    <div v-if="wb.loadError" class="load-error">
      <n-result status="404" title="项目不存在" :description="wb.loadError">
        <template #footer>
          <n-button type="primary" @click="router.push('/')">返回项目列表</n-button>
        </template>
      </n-result>
    </div>

    <n-spin v-else-if="wb.loading" class="load-error" />

    <div v-else :key="wb.project?.id" class="columns">
      <ResizablePageSidebar>
        <PagePanel />
      </ResizablePageSidebar>
      <main class="col-center">
        <CanvasPanel />
      </main>
      <ResizableInspectorPanel v-if="auth.canEdit">
        <n-tabs type="line" size="small" default-value="refine" class="inspector-tabs">
          <n-tab-pane name="refine" tab="微调">
            <RefineChat />
          </n-tab-pane>
          <n-tab-pane name="versions" tab="版本">
            <VersionList />
          </n-tab-pane>
          <n-tab-pane name="info" tab="信息">
            <PageInfoForm />
          </n-tab-pane>
        </n-tabs>
      </ResizableInspectorPanel>
    </div>
  </div>
</template>

<style scoped>
.workbench {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--qp-border);
  flex-shrink: 0;
}

.project-name {
  font-weight: 600;
  font-size: 14px;
}

.style-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 4px;
  vertical-align: -1px;
}

.topbar-model {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 400px;
}

.global-constraints-panel {
  height: min(64vh, 640px);
  min-height: 240px;
}

.load-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.columns {
  flex: 1;
  min-height: 0;
  display: flex;
}

.col-center {
  flex: 1;
  min-width: 0;
}

.inspector-tabs {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.inspector-tabs :deep(.n-tabs-nav) {
  padding: 0 112px 0 14px;
  flex-shrink: 0;
}

.inspector-tabs :deep(.n-tabs-pane-wrapper),
.inspector-tabs :deep(.n-tab-pane) {
  height: 100%;
  padding: 0 !important;
}

.inspector-tabs :deep(.n-tabs-pane-wrapper) {
  flex: 1;
  min-height: 0;
}
</style>
