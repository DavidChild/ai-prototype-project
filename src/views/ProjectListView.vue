<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDialog, useMessage } from 'naive-ui'
import type { Project, ProjectEndpointProfile } from '@/types/project'
import type { IterationTask } from '@/types/iterationTask'
import { projectRepo, pageRepo } from '@/services/storage/repositories'
import { getStylePreset } from '@/data/stylePresets'
import { formatTime } from '@/utils/format'
import { useSettingsStore } from '@/stores/settings'
import { useIterationSelectionStore } from '@/stores/iterationSelection'
import { useAuthStore } from '@/stores/auth'
import AccountSettingsDialog from '@/components/account/AccountSettingsDialog.vue'
import ShareMenu from '@/components/workbench/ShareMenu.vue'
import { importProjectPackage } from '@/services/storage/projectPackage'
import CreateIterationDialog from '@/components/project/CreateIterationDialog.vue'

const router = useRouter()
const dialog = useDialog()
const message = useMessage()
const settings = useSettingsStore()
const auth = useAuthStore()
const accountSettingsShow = ref(false)
const projectPackageInput = ref<HTMLInputElement | null>(null)
const importingProject = ref(false)
async function logout() { await auth.logout(); await router.push('/login') }
const roleLabel = computed(() => auth.isReviewer ? '审阅者' : auth.isAdmin ? '管理员' : '设计员')
const userInitial = computed(() => (auth.user?.displayName || auth.user?.email || 'U').trim().slice(0, 1).toUpperCase())

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
const copyTarget = ref<Project | null>(null)
function openCopy(project: Project) {
  copyTarget.value = project
  copyShow.value = true
}
function handleTaskReady(task: IterationTask) {
  void router.push(`/iterations/${task.id}`)
}
const pageCounts = ref(new Map<string, number>())
const loading = ref(true)
const showHidden = ref(false)
const adminSearch = ref('')
const visibilitySaving = ref(new Set<string>())
const hiddenCount = computed(
  () => projectFamilies.value.filter(({ selected }) => selected.hidden).length,
)
const visibleProjects = computed(() => {
  let families = projectFamilies.value.filter(({ selected }) => showHidden.value ? Boolean(selected.hidden) : !selected.hidden)
  const keyword = adminSearch.value.trim().toLowerCase()
  if (auth.isAdmin && keyword) {
    families = families.filter(({ selected }) =>
      [
        selected.name,
        selected.iteration,
        selected.platform,
        selected.endpointProfile?.nature,
        selected.endpointProfile?.purpose,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword)),
    )
  }
  return families
})
const visiblePageCount = computed(() => visibleProjects.value.reduce((total, { selected }) => total + (pageCounts.value.get(selected.id) ?? 0), 0))

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
const profileShow = ref(false)
const profileTarget = ref<Project | null>(null)
const profileNature = ref('')
const profilePurpose = ref('')
const profileSaving = ref(false)
const versionManageShow = ref(false)
const versionManageFamilyId = ref('')
const managedVersions = computed(() =>
  projects.value
    .filter((project) => (project.familyId ?? project.id) === versionManageFamilyId.value)
    .sort((a, b) => b.updatedAt - a.updatedAt),
)
const managedProjectName = computed(() => managedVersions.value[0]?.name ?? '项目')

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

function openProfile(project: Project) {
  profileTarget.value = project
  profileNature.value = project.endpointProfile?.nature || ''
  profilePurpose.value = project.endpointProfile?.purpose || ''
  profileShow.value = true
}

async function submitProfile() {
  const target = profileTarget.value
  const profile: ProjectEndpointProfile = {
    nature: profileNature.value.trim(),
    purpose: profilePurpose.value.trim(),
  }
  if (!target || (!profile.nature && !profile.purpose) || profileSaving.value) return
  profileSaving.value = true
  try {
    const saved = await projectRepo.updateProfile(target.id, profile)
    const familyId = target.familyId ?? target.id
    for (const project of projects.value)
      if ((project.familyId ?? project.id) === familyId) project.endpointProfile = saved
    profileShow.value = false
    message.success('项目信息已保存，将用于后续 AI 版本迭代规划')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '项目信息保存失败')
  } finally {
    profileSaving.value = false
  }
}

function openVersionManager(project: Project) {
  versionManageFamilyId.value = project.familyId ?? project.id
  versionManageShow.value = true
}

function confirmRemoveIteration(project: Project) {
  if (managedVersions.value.length <= 1) return
  const familyId = project.familyId ?? project.id
  dialog.warning({
    title: '删除项目版本',
    content: `确认删除「${project.name} · ${project.iteration ?? 'v1.0'}」？该版本下的页面、页面历史、需求文档和图片都会永久删除，其他版本不受影响。`,
    positiveText: '确认删除版本',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await projectRepo.removeCascade(project.id)
        const remaining = managedVersions.value.filter((item) => item.id !== project.id)
        if (selectedIterations.value[familyId] === project.id && remaining.length)
          selectedIterations.value[familyId] = remaining[0]!.id
        message.success(`版本 ${project.iteration ?? 'v1.0'} 已删除`)
        await refresh()
      } catch (error) {
        message.error(error instanceof Error ? error.message : '版本删除失败')
      }
    },
  })
}

async function initialize() {
  await refresh()
}

async function importPackage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || importingProject.value) return
  importingProject.value = true
  try {
    const projectId = await importProjectPackage(file)
    message.success('项目包已导入')
    await router.push('/project/' + projectId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '项目包导入失败')
  } finally {
    importingProject.value = false
  }
}

onMounted(initialize)
</script>

<template>
  <div :class="auth.isAdmin ? 'admin-shell' : 'project-list-page'">
    <aside v-if="auth.isAdmin" class="admin-sidebar">
      <div class="admin-brand">
        <span class="brand-mark">豆</span>
        <div><strong>小豆原型</strong><small>团队设计空间</small></div>
      </div>
      <nav class="admin-nav" aria-label="团队管理导航">
        <button :class="{ active: !showHidden }" @click="showHidden = false"><span class="nav-icon">▦</span><span>全部项目</span><em>{{ projectFamilies.length - hiddenCount }}</em></button>
        <button :class="{ active: showHidden }" @click="showHidden = true"><span class="nav-icon">◉</span><span>隐藏项目</span><em>{{ hiddenCount }}</em></button>
        <button @click="router.push('/iterations')"><span class="nav-icon">⇄</span><span>多端迭代</span></button>
        <div class="nav-divider" />
        <button @click="router.push('/saas')"><span class="nav-icon">♙</span><span>团队管理</span></button>
        <button @click="router.push('/usage')"><span class="nav-icon">◫</span><span>用量使用情况</span></button>
        <button @click="router.push('/settings')"><span class="nav-icon">⚙</span><span>模型设置</span></button>
      </nav>
      <div class="sidebar-account">
        <n-avatar round size="medium">{{ userInitial }}</n-avatar>
        <div><strong>{{ auth.user?.tenantName || '个人工作区' }}</strong><span>{{ auth.user?.displayName }} · {{ roleLabel }}</span></div>
      </div>
    </aside>
    <main :class="auth.isAdmin ? 'admin-main' : 'member-main'">
    <header :class="auth.isAdmin ? 'admin-topbar' : 'page-head'">
      <div v-if="!auth.isAdmin" class="brand-block">
        <h1 class="title">小豆原型</h1>
        <n-text depth="3" class="subtitle">上传需求文档，自动理解需求并批量生成统一风格的高保真原型</n-text>
      </div>
      <n-input v-else v-model:value="adminSearch" clearable class="project-search" placeholder="搜索项目名称、版本或终端"><template #prefix>⌕</template></n-input>
      <div v-if="auth.isAdmin" class="admin-top-actions">
        <n-button secondary :loading="importingProject" @click="projectPackageInput?.click()">导入项目</n-button>
        <n-button type="primary" @click="router.push('/project/new')">+ 新建项目</n-button>
        <n-button secondary @click="accountSettingsShow = true">账号设置</n-button>
        <n-button secondary :title="settings.appTheme === 'dark' ? '切换到浅色' : '切换到深色'" @click="settings.toggleAppTheme()">{{ settings.appTheme === 'dark' ? '🌙' : '☀️' }}</n-button>
        <n-button quaternary @click="logout">退出登录</n-button>
      </div>
      <input v-if="auth.isAdmin" ref="projectPackageInput" type="file" accept=".xdproto,application/x-xiaodou-prototype" hidden @change="importPackage" />
    </header>

    <div v-if="!auth.isAdmin" class="workspace-toolbar">
      <div class="workspace-identity">
        <n-avatar round size="medium">{{ userInitial }}</n-avatar>
        <div class="identity-copy">
          <strong>{{ auth.user?.tenantName || '个人工作区' }}</strong>
          <span>{{ auth.user?.displayName }} · {{ roleLabel }}</span>
        </div>
      </div>
      <div class="toolbar-actions">
        <n-space size="small">
          <n-button v-if="auth.canCreateProject" type="primary" @click="router.push('/project/new')">+ 新建项目</n-button>
          <n-button secondary @click="accountSettingsShow = true">账号设置</n-button>
        </n-space>
        <span class="toolbar-divider" />
        <n-space size="small">
        <n-button
          v-if="auth.isAdmin"
          secondary
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
          secondary
          :title="settings.appTheme === 'dark' ? '切换到浅色' : '切换到深色'"
          @click="settings.toggleAppTheme()"
        >
          {{ settings.appTheme === 'dark' ? '🌙' : '☀️' }}
        </n-button>
          <n-button quaternary @click="logout">退出登录</n-button>
        </n-space>
      </div>
    </div>

    <section :class="{ 'admin-content': auth.isAdmin }">
    <div v-if="auth.isAdmin" class="admin-heading">
      <div><span class="heading-kicker">{{ auth.user?.tenantName || '团队工作区' }}</span><h1>{{ showHidden ? '隐藏项目' : '项目工作台' }}</h1><p>{{ showHidden ? '管理已隐藏项目，取消隐藏后团队成员即可重新访问。' : '创建、管理并进入团队的原型设计项目。' }}</p></div>
    </div>
    <div v-if="auth.isAdmin" class="admin-stats">
      <div><span>可见项目</span><strong>{{ projectFamilies.length - hiddenCount }}</strong></div>
      <div><span>隐藏项目</span><strong>{{ hiddenCount }}</strong></div>
      <div><span>当前页面</span><strong>{{ visiblePageCount }}</strong></div>
    </div>
    <div class="project-section-head">
      <div>
        <h2>{{ auth.isAdmin ? (showHidden ? '已隐藏' : '全部项目') : '我的项目' }}</h2>
        <n-text depth="3">{{ visibleProjects.length }} 个项目 · {{ visiblePageCount }} 个页面</n-text>
      </div>
      <n-tag v-if="adminSearch" :bordered="false">搜索“{{ adminSearch }}”</n-tag>
    </div>


    <n-spin v-if="loading" style="margin: 80px auto; display: block" />

    <n-empty
      v-else-if="!projects.length"
      description="还没有项目"
      style="margin-top: 100px"
      size="large"
    >
      <template #extra>
          <n-button v-if="auth.canCreateProject" type="primary" @click="router.push('/project/new')">创建第一个项目</n-button>
      </template>
    </n-empty>

    <n-empty
      v-else-if="!visibleProjects.length"
      :description="adminSearch ? '没有匹配的项目' : showHidden ? '暂无隐藏项目' : '暂无可访问项目'"
      style="margin-top: 100px"
      size="large"
    >
      <template #extra>
        <n-button v-if="auth.isAdmin && !showHidden" @click="showHidden = true">查看隐藏项目</n-button>
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
          <div v-if="p.endpointProfile?.nature || p.endpointProfile?.purpose" class="project-profile-summary">
            <strong v-if="p.endpointProfile?.nature">{{ p.endpointProfile.nature }}</strong>
            <span v-if="p.endpointProfile?.purpose">{{ p.endpointProfile.purpose }}</span>
          </div>
        </n-space>
        <template #action>
          <div class="card-actions" @click.stop>
            <div class="version-actions">
              <n-select
                :value="p.id"
                size="tiny"
                aria-label="选择项目迭代版本"
                style="width: 100px; flex-shrink: 0"
                :options="versions.map((v) => ({ label: v.iteration ?? 'v1.0', value: v.id }))"
                @update:value="(id: string) => (selectedIterations[p.familyId ?? p.id] = id)"
              />
              <ShareMenu
                v-if="auth.canEdit"
                :project="p"
                fixed-scope="iteration"
                button-size="tiny"
                button-quaternary
              />
            </div>
            <n-space v-if="!auth.isReviewer" justify="end" size="small">
              <n-button size="tiny" quaternary @click="openProfile(p)">项目信息</n-button>
              <n-button v-if="auth.isAdmin" size="tiny" quaternary @click="openVersionManager(p)">版本管理</n-button>
              <n-button v-if="auth.canCreateIteration" size="tiny" quaternary @click="openCopy(p)">新建版本</n-button>
              <n-button size="tiny" quaternary type="primary" @click="enterProject(p)"
                >进入</n-button
              >
              <n-button
                v-if="auth.isAdmin"
                size="tiny"
                quaternary
                :loading="visibilitySaving.has(p.id)"
                @click="toggleHidden(p)"
              >
                {{ p.hidden ? '取消隐藏' : '隐藏' }}
              </n-button>
              <n-button v-if="auth.isAdmin" size="tiny" quaternary @click="openRename(p)">重命名</n-button>
              <n-button v-if="auth.isAdmin" size="tiny" quaternary type="error" @click="confirmRemove(p)"
                >删除</n-button
              >
            </n-space>
          </div>
        </template>
      </n-card>
    </div>
    </section>

    <CreateIterationDialog
      v-model:show="copyShow"
      :source="copyTarget"
      :projects="projects"
      :allow-synchronized="false"
      @task-ready="handleTaskReady"
    />
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
    <n-modal
      v-model:show="profileShow"
      preset="card"
      title="项目信息"
      style="width: min(560px, 94vw)"
      :mask-closable="!profileSaving"
      :closable="!profileSaving"
    >
      <n-alert type="info" :bordered="false" class="profile-ai-note">
        这些信息用于帮助 AI 理解当前项目属于什么端、承担什么业务。后续新建版本或关联多个端同步迭代时，会自动作为页面变更与缺失页面规划的上下文。
      </n-alert>
      <n-form label-placement="top">
        <n-form-item label="端性质">
          <n-input
            v-model:value="profileNature"
            maxlength="120"
            show-count
            :disabled="profileSaving"
            placeholder="例如：平台运营管理端、企业 B 端 PC 管理后台、消费者 C 端小程序"
          />
        </n-form-item>
        <n-form-item label="项目用途">
          <n-input
            v-model:value="profilePurpose"
            type="textarea"
            :rows="5"
            maxlength="2000"
            show-count
            :disabled="profileSaving"
            placeholder="说明服务对象、核心业务、该端承担的职责，以及与其他端的协作关系。"
          />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button :disabled="profileSaving" @click="profileShow = false">取消</n-button>
          <n-button
            type="primary"
            :loading="profileSaving"
            :disabled="!profileNature.trim() && !profilePurpose.trim()"
            @click="submitProfile"
          >
            保存项目信息
          </n-button>
        </n-space>
      </template>
    </n-modal>
    <n-modal
      v-model:show="versionManageShow"
      preset="card"
      :title="`${managedProjectName} · 版本管理`"
      style="width: min(620px, 94vw)"
    >
      <n-alert type="warning" :bordered="false" class="version-manage-note">
        删除版本会同步删除该版本下的页面、页面历史、需求文档和图片，且无法恢复。至少需要保留一个版本。
      </n-alert>
      <div class="version-manage-list">
        <div v-for="version in managedVersions" :key="version.id" class="version-manage-row">
          <div>
            <strong>{{ version.iteration ?? 'v1.0' }}</strong>
            <span>
              {{ pageCounts.get(version.id) ?? 0 }} 个页面 · 更新于 {{ formatTime(version.updatedAt) }}
            </span>
          </div>
          <n-tag
            v-if="selectedIterations[version.familyId ?? version.id] === version.id"
            size="small"
            :bordered="false"
            type="info"
          >
            当前选择
          </n-tag>
          <n-button
            size="small"
            secondary
            type="error"
            :disabled="managedVersions.length <= 1"
            :title="managedVersions.length <= 1 ? '至少需要保留一个版本' : `删除版本 ${version.iteration ?? 'v1.0'}`"
            @click="confirmRemoveIteration(version)"
          >
            删除
          </n-button>
        </div>
      </div>
      <template #footer>
        <n-space justify="end">
          <n-button @click="versionManageShow = false">关闭</n-button>
        </n-space>
      </template>
    </n-modal>
    <AccountSettingsDialog v-model:show="accountSettingsShow" />
    </main>
  </div>
</template>

<style scoped>
.project-list-page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 42px 28px 64px;
}

.admin-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr);
  background: color-mix(in srgb, var(--qp-pane) 32%, transparent);
}

.admin-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 22px 14px 16px;
  border-right: 1px solid var(--qp-border);
  background: var(--qp-pane);
}

.admin-brand,
.sidebar-account,
.admin-top-actions {
  display: flex;
  align-items: center;
}

.admin-brand {
  gap: 11px;
  padding: 0 10px 22px;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 11px;
  color: white;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  box-shadow: 0 8px 20px rgba(99, 102, 241, .24);
  font-weight: 800;
}

.admin-brand div,
.sidebar-account div {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.admin-brand strong { font-size: 17px; }
.admin-brand small,
.sidebar-account span { color: var(--qp-text-muted); font-size: 11px; }
.admin-nav { display: flex; flex-direction: column; gap: 5px; }
.admin-nav button {
  width: 100%;
  display: grid;
  grid-template-columns: 24px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 0;
  border-radius: 9px;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.admin-nav button:hover { background: color-mix(in srgb, #6366f1 9%, transparent); }
.admin-nav button.active { color: #6366f1; background: color-mix(in srgb, #6366f1 14%, transparent); font-weight: 700; }
.admin-nav em { min-width: 23px; padding: 1px 7px; border-radius: 20px; color: var(--qp-text-muted); background: color-mix(in srgb, var(--qp-border) 55%, transparent); font-size: 11px; font-style: normal; text-align: center; }
.nav-icon { color: var(--qp-text-muted); font-size: 16px; text-align: center; }
.nav-divider { height: 1px; margin: 10px 8px; background: var(--qp-border); }
.sidebar-account { gap: 10px; margin-top: auto; padding: 13px 10px 2px; border-top: 1px solid var(--qp-border); }
.sidebar-account strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.admin-main { min-width: 0; }
.admin-topbar {
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 0 30px;
  border-bottom: 1px solid var(--qp-border);
  background: color-mix(in srgb, var(--qp-pane) 94%, transparent);
}
.project-search { width: min(440px, 48vw); }
.admin-top-actions { justify-content: flex-end; gap: 8px; }
.admin-content { padding: 32px clamp(22px, 3vw, 48px) 64px; }
.admin-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 30px; margin-bottom: 24px; }
.admin-heading h1 { margin: 5px 0 7px; font-size: 28px; }
.admin-heading p { margin: 0; color: var(--qp-text-muted); }
.heading-kicker { color: #6366f1; font-size: 12px; font-weight: 700; letter-spacing: .08em; }
.admin-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 30px; }
.admin-stats div { padding: 16px 18px; border: 1px solid var(--qp-border); border-radius: 12px; background: var(--qp-pane); }
.admin-stats span { display: block; color: var(--qp-text-muted); font-size: 12px; }
.admin-stats strong { display: block; margin-top: 5px; font-size: 24px; }

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 28px;
  margin-bottom: 22px;
}

.brand-block {
  min-width: 0;
}

.brand-kicker {
  display: block;
  margin-bottom: 7px;
  color: #6366f1;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .13em;
}

.title {
  margin: 0 0 7px;
  font-size: 27px;
  line-height: 1.25;
}

.subtitle {
  display: block;
  font-size: 13px;
}

.workspace-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 14px 16px;
  margin-bottom: 32px;
  border: 1px solid var(--qp-border);
  border-radius: 10px;
  background: var(--qp-pane);
}

.workspace-identity,
.toolbar-actions {
  display: flex;
  align-items: center;
}

.workspace-identity {
  gap: 11px;
  min-width: 190px;
}

.identity-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.identity-copy strong {
  font-size: 13px;
}

.identity-copy span {
  color: var(--qp-text-muted);
  font-size: 11px;
}

.toolbar-actions {
  justify-content: flex-end;
  gap: 14px;
}

.toolbar-divider {
  width: 1px;
  height: 24px;
  background: var(--qp-border);
}

.project-section-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 16px;
}

.project-section-head h2 {
  margin: 0 0 4px;
  font-size: 17px;
}

.iteration-task-panel {
  margin-bottom: 18px;
  border: 1px solid color-mix(in srgb, #f59e0b 42%, var(--qp-border));
  border-radius: 6px;
  background: var(--qp-pane);
}

.iteration-task-head,
.iteration-task-row,
.iteration-task-title,
.iteration-task-actions {
  display: flex;
  align-items: center;
}

.iteration-task-head {
  justify-content: space-between;
  gap: 16px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--qp-border);
}

.iteration-task-head > div {
  display: grid;
  gap: 2px;
}

.iteration-task-head span,
.iteration-task-main > span {
  color: var(--qp-text-muted);
  font-size: 11px;
}

.iteration-task-row {
  justify-content: space-between;
  gap: 18px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--qp-border);
}

.iteration-task-row:last-child {
  border-bottom: 0;
}

.iteration-task-main {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.iteration-task-title {
  gap: 8px;
}

.iteration-session-ids {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.iteration-task-main em {
  color: #ef4444;
  font-size: 11px;
  font-style: normal;
  white-space: pre-line;
}

.iteration-task-actions {
  flex-shrink: 0;
  gap: 6px;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.project-card {
  cursor: pointer;
}

.project-profile-summary {
  display: grid;
  gap: 3px;
  padding: 8px 10px;
  border-left: 2px solid #3b82f6;
  background: color-mix(in srgb, var(--qp-pane) 70%, transparent);
  font-size: 11px;
}

.project-profile-summary strong {
  color: var(--qp-text);
  font-size: 12px;
}

.project-profile-summary span {
  display: -webkit-box;
  overflow: hidden;
  color: var(--qp-text-muted);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.profile-ai-note {
  margin-bottom: 16px;
}

.version-manage-note {
  margin-bottom: 14px;
}

.version-manage-list {
  overflow: hidden;
  border: 1px solid var(--qp-border);
  border-radius: 6px;
}

.version-manage-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 70px;
  align-items: center;
  gap: 12px;
  min-height: 62px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--qp-border);
}

.version-manage-row:last-child {
  border-bottom: 0;
}

.version-manage-row > div {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.version-manage-row strong {
  font-size: 14px;
}

.version-manage-row span {
  color: var(--qp-text-muted);
  font-size: 11px;
}

.card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.version-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.proj-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 8px;
}

@media (max-width: 900px) {
  .admin-shell { grid-template-columns: 76px minmax(0, 1fr); }
  .admin-sidebar { padding-inline: 9px; }
  .admin-brand { justify-content: center; padding-inline: 10px; }
  .admin-brand div,
  .admin-nav button span:not(.nav-icon),
  .admin-nav em,
  .sidebar-account div { display: none; }
  .admin-nav button { display: flex; justify-content: center; padding: 12px; }
  .sidebar-account { justify-content: center; padding-inline: 0; }
  .workspace-toolbar,
  .toolbar-actions {
    align-items: flex-start;
    flex-direction: column;
  }

  .toolbar-actions {
    width: 100%;
  }

  .toolbar-divider {
    width: 100%;
    height: 1px;
  }
}

@media (max-width: 720px) {
  .admin-shell { display: block; }
  .admin-sidebar { position: static; width: auto; height: auto; padding: 10px 12px; flex-direction: row; align-items: center; gap: 10px; }
  .admin-brand { padding: 0; }
  .admin-brand div,
  .sidebar-account { display: none; }
  .admin-nav { flex: 1; flex-direction: row; justify-content: flex-end; }
  .admin-nav button { width: auto; }
  .admin-nav button span:not(.nav-icon),
  .nav-divider { display: none; }
  .admin-topbar { height: auto; padding: 12px 16px; flex-wrap: wrap; }
  .project-search { width: 100%; order: 2; }
  .admin-top-actions { width: 100%; }
  .admin-content { padding: 24px 16px 48px; }
  .admin-heading { align-items: stretch; flex-direction: column; }
  .admin-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .project-list-page {
    padding: 26px 16px 48px;
  }

  .page-head {
    align-items: stretch;
    flex-direction: column;
  }

  .card-grid {
    grid-template-columns: 1fr;
  }

  .version-manage-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .version-manage-row > .n-tag {
    display: none;
  }

  .iteration-task-row {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
