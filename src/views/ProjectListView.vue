<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDialog, useMessage } from 'naive-ui'
import type { Project } from '@/types/project'
import { projectRepo, pageRepo } from '@/services/storage/repositories'
import { getStylePreset } from '@/data/stylePresets'
import { formatTime } from '@/utils/format'
import { useSettingsStore } from '@/stores/settings'
import { useIterationSelectionStore } from '@/stores/iterationSelection'

const router = useRouter()
const dialog = useDialog()
const message = useMessage()
const settings = useSettingsStore()

const projects = ref<Project[]>([])
const iterationSelection = useIterationSelectionStore()
const selectedIterations = computed(() => iterationSelection.selected)
const projectFamilies = computed(() => {
  const groups = new Map<string, Project[]>()
  for (const project of projects.value) {
    const key = project.familyId ?? project.id
    const group = groups.get(key) ?? []
    group.push(project)
    groups.set(key, group)
  }
  return [...groups.values()].map((versions) => ({
    versions,
    selected:
      versions.find(
        (p) => p.id === selectedIterations.value[versions[0]!.familyId ?? versions[0]!.id],
      ) ?? versions[0]!,
  }))
})
function enterProject(project: Project) {
  iterationSelection.select(project.familyId ?? project.id, project.id)
  void router.push(`/project/${project.id}`)
}
const copyShow = ref(false)
const copySource = ref('')
const copyLabel = ref('')
const copyFamily = ref('')
const copying = ref(false)
const copyOptions = computed(() =>
  projects.value
    .filter((p) => (p.familyId ?? p.id) === copyFamily.value)
    .map((p) => ({ label: p.iteration ?? 'v1.0', value: p.id })),
)
function openCopy(project: Project) {
  copyFamily.value = project.familyId ?? project.id
  copySource.value = project.id
  copyLabel.value = ''
  copyShow.value = true
}
async function submitCopy() {
  if (copying.value || !copySource.value || !copyLabel.value.trim()) return
  copying.value = true
  try {
    const target = await projectRepo.copyIteration(copySource.value, copyLabel.value)
    selectedIterations.value[target.familyId!] = target.id
    await refresh()
    copyShow.value = false
    message.success('新版本已复制，可选择该版本进入开发')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '复制版本失败')
  } finally {
    copying.value = false
  }
}
const pageCounts = ref(new Map<string, number>())
const loading = ref(true)
const showHidden = ref(false)
const visibilitySaving = ref(new Set<string>())
const hiddenCount = computed(
  () => projectFamilies.value.filter(({ selected }) => selected.hidden).length,
)
const visibleProjects = computed(() =>
  projectFamilies.value.filter(({ selected }) => showHidden.value || !selected.hidden),
)

async function toggleHidden(project: Project) {
  if (visibilitySaving.value.has(project.id)) return
  visibilitySaving.value.add(project.id)
  const hidden = !project.hidden
  try {
    await projectRepo.updateFamily(project.familyId ?? project.id, { hidden })
    for (const p of projects.value)
      if ((p.familyId ?? p.id) === (project.familyId ?? project.id)) p.hidden = hidden
    message.success(hidden ? '已隐藏，可通过右上角小眼睛查看' : '已取消隐藏')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '操作失败，请重试')
  } finally {
    visibilitySaving.value.delete(project.id)
  }
}

const renameShow = ref(false)
const renameTarget = ref<Project | null>(null)
const renameValue = ref('')

async function refresh() {
  loading.value = true
  try {
    projects.value = await projectRepo.list()
    const counts = new Map<string, number>()
    for (const p of projects.value) {
      counts.set(p.id, (await pageRepo.listByProject(p.id)).length)
    }
    pageCounts.value = counts
  } finally {
    loading.value = false
  }
}

function confirmRemove(project: Project) {
  dialog.warning({
    title: '删除项目',
    content: `删除「${project.name}」的所有迭代版本、页面、历史与文档？此操作不可恢复。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await projectRepo.removeFamily(project.familyId ?? project.id)
      message.success('已删除')
      await refresh()
    },
  })
}

function openRename(project: Project) {
  renameTarget.value = project
  renameValue.value = project.name
  renameShow.value = true
}

async function submitRename() {
  const name = renameValue.value.trim()
  if (!name || !renameTarget.value) return
  await projectRepo.updateFamily(renameTarget.value.familyId ?? renameTarget.value.id, { name })
  renameShow.value = false
  await refresh()
}

onMounted(refresh)
</script>

<template>
  <div class="project-list-page">
    <header class="page-head">
      <div>
        <h1 class="title">快页 <span class="title-en">QuickPage</span></h1>
        <n-text depth="3">上传需求文档，自动理解需求并批量生成统一风格的高保真原型</n-text>
      </div>
      <n-space>
        <n-button
          quaternary
          :type="showHidden ? 'primary' : 'default'"
          role="switch"
          :aria-checked="showHidden"
          aria-label="显示隐藏项目"
          :title="`${showHidden ? '收起隐藏项目' : '显示隐藏项目'}（${hiddenCount} 个）`"
          @click="showHidden = !showHidden"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
            <path v-if="!showHidden" d="m3 3 18 18" />
          </svg>
        </n-button>
        <n-button
          quaternary
          :title="settings.appTheme === 'dark' ? '切换到浅色' : '切换到深色'"
          @click="settings.toggleAppTheme()"
        >
          {{ settings.appTheme === 'dark' ? '🌙' : '☀️' }}
        </n-button>
        <n-button quaternary @click="router.push('/settings')">设置</n-button>
        <n-button type="primary" @click="router.push('/project/new')">+ 新建项目</n-button>
      </n-space>
    </header>

    <n-spin v-if="loading" style="margin: 80px auto; display: block" />

    <n-empty
      v-else-if="!projects.length"
      description="还没有项目"
      style="margin-top: 100px"
      size="large"
    >
      <template #extra>
        <n-button type="primary" @click="router.push('/project/new')">创建第一个项目</n-button>
      </template>
    </n-empty>

    <n-empty
      v-else-if="!visibleProjects.length"
      description="项目已全部隐藏，点击右上角小眼睛查看"
      style="margin-top: 100px"
      size="large"
    >
      <template #extra>
        <n-button @click="showHidden = true">显示隐藏项目</n-button>
      </template>
    </n-empty>

    <div v-else class="card-grid">
      <n-card
        v-for="{ selected: p, versions } in visibleProjects"
        :key="p.familyId ?? p.id"
        size="small"
        hoverable
        class="project-card"
        @click="enterProject(p)"
      >
        <template #header>
          <span class="proj-dot" :style="{ background: p.styleSpec.tokens.primaryColor }" />
          {{ p.name }}
        </template>
        <template #header-extra>
          <n-space size="small">
            <n-tag v-if="p.hidden" size="small" :bordered="false" type="warning">已隐藏</n-tag>
            <n-tag size="small" :bordered="false">
              {{ p.platform === 'pc' ? 'PC' : 'H5' }}
            </n-tag>
          </n-space>
        </template>
        <n-space vertical size="small">
          <n-text depth="3" style="font-size: 12px">
            {{ getStylePreset(p.styleSpec.presetId)?.name ?? '自定义风格' }}
            · {{ pageCounts.get(p.id) ?? 0 }} 个页面
          </n-text>
          <n-text depth="3" style="font-size: 12px"> 更新于 {{ formatTime(p.updatedAt) }} </n-text>
        </n-space>
        <template #action>
          <div class="card-actions" @click.stop>
            <n-select
              :value="p.id"
              size="tiny"
              aria-label="选择项目迭代版本"
              style="width: 100px; flex-shrink: 0"
              :options="versions.map((v) => ({ label: v.iteration ?? 'v1.0', value: v.id }))"
              @update:value="(id: string) => (selectedIterations[p.familyId ?? p.id] = id)"
            />
            <n-space justify="end" size="small">
              <n-button size="tiny" quaternary @click="openCopy(p)">新建版本</n-button>
              <n-button size="tiny" quaternary type="primary" @click="enterProject(p)"
                >进入</n-button
              >
              <n-button
                size="tiny"
                quaternary
                :loading="visibilitySaving.has(p.id)"
                @click="toggleHidden(p)"
              >
                {{ p.hidden ? '取消隐藏' : '隐藏' }}
              </n-button>
              <n-button size="tiny" quaternary @click="openRename(p)">重命名</n-button>
              <n-button size="tiny" quaternary type="error" @click="confirmRemove(p)"
                >删除</n-button
              >
            </n-space>
          </div>
        </template>
      </n-card>
    </div>

    <n-modal
      v-model:show="copyShow"
      preset="card"
      title="新建迭代版本"
      style="width: 440px"
      :mask-closable="!copying"
      :closable="!copying"
      :close-on-esc="!copying"
    >
      <n-form label-placement="top" size="small">
        <n-form-item label="基于已有版本复制（必选）">
          <n-select v-model:value="copySource" :options="copyOptions" :disabled="copying" />
        </n-form-item>
        <n-form-item label="新版本号">
          <n-input
            v-model:value="copyLabel"
            placeholder="例如 v1.1 或 v2.0"
            :disabled="copying"
            @keyup.enter="submitCopy"
          />
        </n-form-item>
        <n-text depth="3">复制页面、生成内容、历史记录和文档；各版本后续修改互不影响。</n-text>
      </n-form>
      <template #footer
        ><n-space justify="end">
          <n-button :disabled="copying" @click="copyShow = false">取消</n-button>
          <n-button
            type="primary"
            :loading="copying"
            :disabled="!copySource || !copyLabel.trim()"
            @click="submitCopy"
            >复制新版本</n-button
          >
        </n-space></template
      >
    </n-modal>
    <n-modal v-model:show="renameShow" preset="card" title="重命名项目" style="width: 400px">
      <n-input v-model:value="renameValue" @keyup.enter="submitRename" />
      <template #footer>
        <n-space justify="end">
          <n-button @click="renameShow = false">取消</n-button>
          <n-button type="primary" :disabled="!renameValue.trim()" @click="submitRename">
            保存
          </n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.project-list-page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 32px 24px;
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 28px;
}

.title {
  margin: 0 0 4px;
  font-size: 22px;
}

.title-en {
  font-size: 15px;
  font-weight: 500;
  opacity: 0.55;
  margin-left: 2px;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
  gap: 14px;
}

.project-card {
  cursor: pointer;
}
.card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.proj-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 8px;
}
</style>
