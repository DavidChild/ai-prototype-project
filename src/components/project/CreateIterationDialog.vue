<script setup lang="ts">
import { computed, markRaw, reactive, ref, watch } from 'vue'
import { nanoid } from 'nanoid'
import { useMessage } from 'naive-ui'
import type { Project } from '@/types/project'
import type { Page } from '@/types/page'
import type { ParsedDocument } from '@/types/parsing'
import type { IterationTask } from '@/types/iterationTask'
import { FILE_ACCEPT, mergeDocuments, parseFile } from '@/services/parsing'
import { MAX_ANALYSIS_IMAGES } from '@/services/generation/analyzeRequirements'
import { iterationTaskRepo, pageRepo } from '@/services/storage/repositories'
import { useSettingsStore } from '@/stores/settings'
import { truncateStructured } from '@/utils/tokenBudget'
import { formatBytes } from '@/utils/format'
import { blobToBase64 } from '@/utils/blob'

interface RequirementFile {
  id: string
  file: File
  status: 'parsing' | 'done' | 'error'
  doc?: ParsedDocument
  error?: string
}

const props = withDefaults(defineProps<{
  show: boolean
  source: Project | null
  projects: Project[]
  allowSynchronized?: boolean
}>(), {
  allowSynchronized: true,
})
const emit = defineEmits<{
  'update:show': [value: boolean]
  taskReady: [task: IterationTask]
}>()

const settings = useSettingsStore()
const message = useMessage()
const sourceId = ref('')
const primaryLabel = ref('')
const requirementText = ref('')
const files = ref<RequirementFile[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const synchronizedFamilyIds = ref<string[]>([])
const pendingFamilyId = ref<string | null>(null)
const synchronizedSourceIds = reactive<Record<string, string>>({})
const synchronizedLabels = reactive<Record<string, string>>({})
const pagesByProject = reactive(new Map<string, Page[]>())
const processing = ref(false)
const stage = ref('')
let loadSequence = 0

const sourceFamily = computed(() => props.source?.familyId ?? props.source?.id ?? '')
const primaryVersions = computed(() =>
  props.projects
    .filter(
      (project) =>
        !project.hidden && (project.familyId ?? project.id) === sourceFamily.value,
    )
    .map((project) => ({ label: project.iteration ?? 'v1.0', value: project.id })),
)
const selectedSource = computed(() => props.projects.find((project) => project.id === sourceId.value))
const synchronizedOptions = computed(() => {
  const family = selectedSource.value?.familyId ?? selectedSource.value?.id
  const families = new Map<string, Project[]>()
  for (const project of props.projects) {
    if (project.hidden) continue
    const familyId = project.familyId ?? project.id
    if (familyId === family) continue
    const versions = families.get(familyId) ?? []
    versions.push(project)
    families.set(familyId, versions)
  }
  return [...families.entries()].map(([familyId, versions]) => {
    const representative = [...versions].sort((a, b) => b.updatedAt - a.updatedAt)[0]!
    return {
      label: `${representative.name} · ${representative.platform === 'pc' ? 'PC' : '移动端'} · ${versions.length} 个版本`,
      value: familyId,
    }
  })
})
const availableSynchronizedOptions = computed(() =>
  synchronizedOptions.value.filter(
    (option) => !synchronizedFamilyIds.value.includes(option.value),
  ),
)
const endpointIds = computed(() => [
  sourceId.value,
  ...(props.allowSynchronized
    ? synchronizedFamilyIds.value.map((familyId) => synchronizedSourceIds[familyId])
    : []),
].filter(Boolean))
const parsedDocs = computed(() =>
  files.value.filter((item) => item.status === 'done' && item.doc).map((item) => item.doc!),
)
const canSubmit = computed(() => {
  if (!selectedSource.value || !primaryLabel.value.trim() || processing.value) return false
  if (!requirementText.value.trim() && !parsedDocs.value.length) return false
  return !props.allowSynchronized || synchronizedFamilyIds.value.every(
    (familyId) => synchronizedSourceIds[familyId] && synchronizedLabels[familyId]?.trim(),
  )
})
const formDisabled = computed(() => processing.value)

function close() {
  if (!processing.value) emit('update:show', false)
}

async function loadPages(projectId: string): Promise<Page[]> {
  const cached = pagesByProject.get(projectId)
  if (cached) return cached
  const pages = await pageRepo.listByProject(projectId)
  pagesByProject.set(projectId, pages)
  return pages
}

async function reset(project: Project) {
  sourceId.value = project.id
  primaryLabel.value = ''
  requirementText.value = ''
  files.value = []
  synchronizedFamilyIds.value = []
  pendingFamilyId.value = null
  pagesByProject.clear()
  for (const key of Object.keys(synchronizedSourceIds)) delete synchronizedSourceIds[key]
  for (const key of Object.keys(synchronizedLabels)) delete synchronizedLabels[key]
  stage.value = ''
  await loadPages(project.id)
}

watch(
  () => [props.show, props.source?.id] as const,
  ([show]) => {
    if (show && props.source) void reset(props.source)
  },
)

async function selectPrimary(id: string) {
  sourceId.value = id
  await loadPages(id)
}

function versionsForFamily(familyId: string) {
  return props.projects
    .filter(
      (project) => !project.hidden && (project.familyId ?? project.id) === familyId,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function versionOptions(familyId: string) {
  return versionsForFamily(familyId).map((project) => ({
    label: project.iteration ?? 'v1.0',
    value: project.id,
  }))
}

function synchronizedProject(familyId: string) {
  return props.projects.find((project) => project.id === synchronizedSourceIds[familyId])
}

async function selectSynchronized(ids: string[]) {
  const sourceFamilyId = selectedSource.value?.familyId ?? selectedSource.value?.id
  const accepted = ids.filter(
    (familyId) => familyId !== sourceFamilyId && versionsForFamily(familyId).length > 0,
  ).slice(0, 7)
  synchronizedFamilyIds.value = accepted
  for (const familyId of Object.keys(synchronizedSourceIds))
    if (!accepted.includes(familyId)) delete synchronizedSourceIds[familyId]
  for (const familyId of Object.keys(synchronizedLabels))
    if (!accepted.includes(familyId)) delete synchronizedLabels[familyId]
  for (const familyId of accepted) {
    synchronizedSourceIds[familyId] ??= versionsForFamily(familyId)[0]!.id
    synchronizedLabels[familyId] ??= ''
  }
  const sequence = ++loadSequence
  await Promise.all(accepted.map((familyId) => loadPages(synchronizedSourceIds[familyId]!)))
  if (sequence !== loadSequence) return
}

async function addSynchronizedFamily() {
  if (!pendingFamilyId.value) return
  if (synchronizedFamilyIds.value.length >= 7) {
    message.warning('一次最多同步创建 8 个端（含主项目）')
    return
  }
  await selectSynchronized([...synchronizedFamilyIds.value, pendingFamilyId.value])
  pendingFamilyId.value = null
}

function removeSynchronizedFamily(familyId: string) {
  void selectSynchronized(synchronizedFamilyIds.value.filter((id) => id !== familyId))
}

async function selectSynchronizedVersion(familyId: string, projectId: string) {
  synchronizedSourceIds[familyId] = projectId
  await loadPages(projectId)
}

async function addFiles(list: File[]) {
  for (const file of list) {
    if (files.value.some((item) => item.file.name === file.name && item.file.size === file.size))
      continue
    const item = reactive<RequirementFile>({
      id: nanoid(),
      file: markRaw(file),
      status: 'parsing',
    })
    files.value.push(item)
    try {
      item.doc = markRaw(await parseFile(file))
      item.status = 'done'
    } catch (error) {
      item.status = 'error'
      item.error = error instanceof Error ? error.message : '文件解析失败'
    }
  }
}

function pickFiles(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files?.length) void addFiles([...input.files])
  input.value = ''
}

function removeFile(id: string) {
  if (!processing.value) files.value = files.value.filter((item) => item.id !== id)
}

function targetLabel(endpoint: Project) {
  if (endpoint.id === sourceId.value) return primaryLabel.value.trim()
  return synchronizedLabels[endpoint.familyId ?? endpoint.id]?.trim() ?? ''
}

function validateLabels(endpoints: Project[]) {
  for (const endpoint of endpoints) {
    const label = targetLabel(endpoint)
    const family = endpoint.familyId ?? endpoint.id
    if (
      props.projects.some(
        (project) =>
          (project.familyId ?? project.id) === family &&
          (project.iteration ?? 'v1.0').toLowerCase() === label.toLowerCase(),
      )
    )
      throw new Error(`${endpoint.name} 已存在版本号 ${label}`)
  }
}

async function submit() {
  if (!canSubmit.value) return
  processing.value = true
  try {
    const endpoints = endpointIds.value
      .map((id) => props.projects.find((project) => project.id === id && !project.hidden))
      .filter((project): project is Project => !!project)
    if (endpoints.length !== endpointIds.value.length)
      throw new Error('隐藏项目不能加入多端迭代任务，请重新选择项目端')
    validateLabels(endpoints)
    const resolved = settings.resolveModel('analysis')
    if (!resolved) throw new Error('请先在模型设置中配置需求理解模型')
    const generationModels = new Map(
      endpoints.map((endpoint) => [endpoint.id, settings.resolveModel('generation', endpoint.modelOverride)]),
    )
    const missingGenerationModel = endpoints.find((endpoint) => !generationModels.get(endpoint.id))
    if (missingGenerationModel) throw new Error(`${missingGenerationModel.name} 未配置页面生成模型`)
    const merged = parsedDocs.value.length ? mergeDocuments(parsedDocs.value).text : ''
    const combined = [requirementText.value.trim(), merged].filter(Boolean).join('\n\n【上传需求文档】\n')
    const { text } = truncateStructured(combined, settings.genParams.analysisInputBudget)
    const images = parsedDocs.value.flatMap((doc) => doc.images).slice(0, MAX_ANALYSIS_IMAGES)
    const now = Date.now()
    const task = await iterationTaskRepo.create({
      id: nanoid(),
      title: `${endpoints[0]!.name} · ${targetLabel(endpoints[0]!)} 多端迭代`,
      status: 'pending',
      primarySourceId: endpoints[0]!.id,
      requirementText: text,
      documents: parsedDocs.value.map((doc) => ({ fileName: doc.fileName, fileType: doc.fileType, text: doc.text, meta: doc.meta })),
      images: await Promise.all(images.map(async (image) => ({ mimeType: image.mimeType, base64: await blobToBase64(image.blob) }))),
      endpoints: endpoints.map((endpoint) => {
        const generation = generationModels.get(endpoint.id)!
        return {
          sourceProjectId: endpoint.id,
          sourceFamilyId: endpoint.familyId ?? endpoint.id,
          projectName: endpoint.name,
          sourceIteration: endpoint.iteration ?? 'v1.0',
          targetIteration: targetLabel(endpoint),
          generationProviderId: generation.provider.id,
          generationModel: generation.model,
          status: 'pending' as const,
          aiSession: {
            id: nanoid(), providerId: resolved.provider.id, model: resolved.model,
            continuationMode: 'history-replay' as const, system: '', messages: [], updatedAt: now,
          },
        }
      }),
      createdAt: now,
      updatedAt: now,
    })
    emit('taskReady', task)
    emit('update:show', false)
    message.success('多端迭代任务已创建，正在进入任务工作区')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '多端迭代任务创建失败')
  } finally {
    processing.value = false
    stage.value = ''
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="新建迭代版本"
    style="width: min(820px, 95vw)"
    :mask-closable="!processing"
    :closable="!processing"
    :close-on-esc="!processing"
    @update:show="(value: boolean) => !value && close()"
  >
    <n-alert type="info" :bordered="false" class="iteration-rule">
      {{ allowSynchronized
        ? 'AI 会优先在旧版本已有相关页面上进行初始迭代；只有需求没有对应旧页面时才新增页面。每个端都会创建独立的新版本，页面及历史仍归属各自项目版本。'
        : '本次描述和需求文件仅用于当前项目。AI 会优先在旧版本已有相关页面上进行迭代，只有需求没有对应页面时才新增页面。' }}
    </n-alert>

    <n-form label-placement="top" size="small">
      <div class="version-grid">
        <n-form-item label="主项目来源版本" required>
          <n-select
            :value="sourceId"
            :options="primaryVersions"
            :disabled="formDisabled"
            @update:value="selectPrimary"
          />
        </n-form-item>
        <n-form-item label="主项目新版本号" required>
          <n-input v-model:value="primaryLabel" placeholder="例如 v2.1" :disabled="formDisabled" />
        </n-form-item>
      </div>

      <n-form-item label="本次版本功能与变更描述" required>
        <n-input
          v-model:value="requirementText"
          type="textarea"
          :rows="5"
          maxlength="12000"
          show-count
          :disabled="formDisabled"
          :placeholder="allowSynchronized
            ? '说明新增功能、旧页面需要调整的内容、多个端需要保持一致的业务规则。也可以仅上传需求文件。'
            : '说明当前项目新增功能和旧页面需要调整的内容，也可以仅上传需求文件。'"
        />
      </n-form-item>

      <n-form-item label="需求文件">
        <div class="requirement-files">
          <n-button secondary :disabled="formDisabled" @click="fileInput?.click()">上传需求文件</n-button>
          <n-text depth="3">支持 docx / pdf / xlsx / csv / md / txt 及图片，可多选</n-text>
          <input ref="fileInput" type="file" multiple :accept="FILE_ACCEPT" hidden @change="pickFiles" />
          <div v-if="files.length" class="file-list">
            <div v-for="item in files" :key="item.id" class="file-row">
              <div>
                <strong>{{ item.file.name }}</strong>
                <span>{{ formatBytes(item.file.size) }}<template v-if="item.doc"> · {{ item.doc.text.length }} 字符 · {{ item.doc.images.length }} 张图片</template></span>
                <em v-if="item.error">{{ item.error }}</em>
              </div>
              <n-spin v-if="item.status === 'parsing'" :size="16" />
              <n-button v-else size="tiny" quaternary type="error" :disabled="formDisabled" @click="removeFile(item.id)">移除</n-button>
            </div>
          </div>
        </div>
      </n-form-item>

      <template v-if="allowSynchronized">
        <n-divider>多端同步迭代（可选）</n-divider>
        <n-form-item label="选择需要同步迭代的项目端">
        <div class="endpoint-picker">
          <n-select
            v-model:value="pendingFamilyId"
            filterable
            clearable
            :options="availableSynchronizedOptions"
            :disabled="formDisabled || synchronizedFamilyIds.length >= 7"
            placeholder="选择一个已有项目端，如运营管理平台、C 端或小程序"
            @keyup.enter="addSynchronizedFamily"
          />
          <n-button
            secondary
            :disabled="formDisabled || !pendingFamilyId || synchronizedFamilyIds.length >= 7"
            @click="addSynchronizedFamily"
          >
            添加项目端
          </n-button>
        </div>
        <n-text depth="3" class="endpoint-count">
          已添加 {{ synchronizedFamilyIds.length }} 个其他端，可继续添加；一次最多创建 8 个端（含主项目）。
        </n-text>
        </n-form-item>
        <div v-if="synchronizedFamilyIds.length" class="sync-version-list">
        <div class="sync-version-header">
          <span>项目端</span>
          <span>来源版本</span>
          <span>目标新版本</span>
          <span></span>
        </div>
        <div v-for="familyId in synchronizedFamilyIds" :key="familyId" class="sync-version-row">
          <span class="endpoint-name">
            {{ synchronizedProject(familyId)?.name }}
            <small>{{ synchronizedProject(familyId)?.platform === 'pc' ? 'PC' : '移动端' }}</small>
          </span>
          <n-select
            :value="synchronizedSourceIds[familyId]"
            :options="versionOptions(familyId)"
            size="small"
            :disabled="formDisabled"
            @update:value="(value: string) => selectSynchronizedVersion(familyId, value)"
          />
          <n-input
            v-model:value="synchronizedLabels[familyId]"
            size="small"
            placeholder="填写该端新版本号"
            :disabled="formDisabled"
          />
          <n-button
            size="tiny"
            quaternary
            type="error"
            :disabled="formDisabled"
            @click="removeSynchronizedFamily(familyId)"
          >
            移除
          </n-button>
        </div>
        </div>
        <n-alert v-if="synchronizedFamilyIds.length" type="default" :bordered="false" class="sync-hint">
          AI 将读取所选各端的完整项目与页面树，自主判断平台管理端、B/C 端、PC、App、小程序、H5/WAP 等产品性质，并规划需要变更或补建的页面。
        </n-alert>
      </template>
    </n-form>

    <n-alert v-if="stage" type="info" :bordered="false" class="processing-stage">
      <n-spin :size="16" /> {{ stage }}
    </n-alert>

    <template #footer>
      <div class="dialog-footer">
        <n-text depth="3">创建后进入多端迭代任务工作区，由你确认后开始规划与生成。</n-text>
        <n-space justify="end">
          <n-button :disabled="processing" @click="close">取消</n-button>
          <n-button type="primary" :loading="processing" :disabled="!canSubmit" @click="submit">
            {{ allowSynchronized ? `创建 ${1 + synchronizedFamilyIds.length} 个端的迭代任务` : '创建当前项目迭代任务' }}
          </n-button>
        </n-space>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.iteration-rule {
  margin-bottom: 16px;
}

.version-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.requirement-files {
  width: 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.file-list {
  width: 100%;
  border: 1px solid var(--qp-border);
  border-radius: 6px;
}

.file-row,
.sync-version-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--qp-border);
}

.file-row:last-child,
.sync-version-row:last-child {
  border-bottom: 0;
}

.file-row strong,
.file-row span,
.file-row em {
  display: block;
  overflow-wrap: anywhere;
}

.file-row span {
  color: var(--qp-text-faint);
  font-size: 11px;
  margin-top: 2px;
}

.file-row em {
  color: #ef4444;
  font-size: 11px;
  font-style: normal;
}

.sync-version-list {
  margin: -4px 0 14px;
  border: 1px solid var(--qp-border);
  border-radius: 6px;
}

.endpoint-picker {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.endpoint-count {
  display: block;
  width: 100%;
  margin-top: 6px;
  font-size: 11px;
}

.sync-version-header,
.sync-version-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 140px 180px 52px;
  align-items: center;
  gap: 12px;
}

.sync-version-header {
  padding: 8px 10px;
  color: var(--qp-text-faint);
  font-size: 11px;
  border-bottom: 1px solid var(--qp-border);
}

.sync-version-row {
  grid-template-columns: minmax(180px, 1fr) 140px 180px 52px;
}

.endpoint-name {
  font-size: 12px;
}

.endpoint-name small {
  display: block;
  color: var(--qp-text-faint);
  font-size: 11px;
  margin-top: 2px;
}

.sync-hint {
  margin: -4px 0 14px;
}

.processing-stage {
  margin-top: 8px;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

@media (max-width: 640px) {
  .version-grid,
  .endpoint-picker,
  .sync-version-header,
  .sync-version-row {
    grid-template-columns: 1fr;
  }

  .sync-version-header {
    display: none;
  }

  .dialog-footer {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
