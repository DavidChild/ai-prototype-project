<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useDialog, useMessage, type TreeSelectOption } from 'naive-ui'
import {
  normalizePageImportModificationRules,
  type PageImportReference,
  type PageSpec,
} from '@/types/analysis'
import type { Page } from '@/types/page'
import { useWorkbenchStore } from '@/stores/workbench'
import { useSettingsStore } from '@/stores/settings'
import { pageSubtreeIds } from '@/utils/pageTree'
import { pageTypeLockReason } from '@/utils/pageEditing'
import { normalizeImage } from '@/services/parsing/imageOps'
import { blobToBase64 } from '@/utils/blob'
import { inferPageDescription } from '@/services/generation/inferPageDescription'
import PageConstraintEditor from './PageConstraintEditor.vue'
import ImportPageRulesEditor from './ImportPageRulesEditor.vue'
import { buildGenerationConstraints } from '@/prompts/generationConstraints'

const wb = useWorkbenchStore()
const settings = useSettingsStore()
const message = useMessage()
const dialog = useDialog()

const form = reactive<PageSpec>({ id: '', name: '', description: '', blocks: [] })
const parentChoice = ref('')
const referenceFile = ref<HTMLInputElement | null>(null)
const uploadingReference = ref(false)
const saving = ref(false)
const descriptionGenerating = ref(false)
let descriptionController: AbortController | null = null
let descriptionSequence = 0
let uploadSequence = 0
const referenceModes = [
  { label: '高度还原参考图', value: 'faithful' },
  { label: '在参考图基础上创新', value: 'creative' },
]
const generationModes = [
  { label: '仅构建当前页', value: 'current' },
  { label: '基于首个引入页构建', value: 'from-import' },
  { label: 'AI 关联构建', value: 'smart-related' },
]
const importAccessOptions = [
  { label: '只读关联', value: 'readonly' },
  { label: '允许 AI 修改', value: 'editable' },
]
const referencePreview = computed(() => {
  const reference = form.referenceDesign
  return reference ? `data:${reference.mimeType};base64,${reference.base64}` : ''
})
const generationLocked = computed(
  () =>
    wb.refining ||
    wb.localEditingPageId === wb.selectedPageId ||
    ['generating', 'queued'].includes(wb.selectedPage?.genStatus ?? ''),
)
const typeLockReason = computed(() =>
  wb.selectedPage ? pageTypeLockReason(wb.selectedPage, !!wb.selectedHtml) : '',
)

watch(
  () => wb.selectedPage?.spec,
  (spec) => {
    descriptionSequence++
    descriptionController?.abort()
    descriptionController = null
    descriptionGenerating.value = false
    uploadSequence++
    uploadingReference.value = false
    form.referenceDesign = undefined
    form.constraints = undefined
    form.importedPages = []
    form.generationMode = 'current'
    if (!spec) return
    Object.assign(form, JSON.parse(JSON.stringify(spec)) as PageSpec)
    form.parentId = spec.parentId
    form.groupOnly = spec.groupOnly
    parentChoice.value = spec.parentId ?? ''
  },
  { immediate: true },
)

watch(
  () => form.generationMode,
  (mode) => {
    if (mode === 'smart-related' || !form.importedPages?.some((item) => item.access === 'editable'))
      return
    form.importedPages = form.importedPages.map((item) => ({ ...item, access: 'readonly' }))
  },
)

async function pickReference(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    message.error('请选择 PNG、JPG 或 WebP 参考图')
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    message.error('参考图不能超过 10 MB')
    return
  }
  const sequence = ++uploadSequence
  uploadingReference.value = true
  try {
    const image = await normalizeImage(file, 'upload')
    if (sequence !== uploadSequence) return
    if (!image) throw new Error('无法读取参考图，请使用宽高均不少于 32px 的有效图片')
    if (image.blob.size > 2 * 1024 * 1024) throw new Error('参考图压缩后仍过大，请缩小图片后重试')
    const base64 = await blobToBase64(image.blob)
    if (sequence !== uploadSequence) return
    const previous = form.referenceDesign
    form.referenceDesign = {
      name: file.name,
      mimeType: image.mimeType,
      base64,
      width: image.width,
      height: image.height,
      mode: previous?.mode ?? 'faithful',
      innovation: previous?.innovation ?? 0.3,
    }
  } catch (error) {
    if (sequence === uploadSequence)
      message.error(error instanceof Error ? error.message : '参考图读取失败')
  } finally {
    if (sequence === uploadSequence) uploadingReference.value = false
  }
}

function removeReference() {
  uploadSequence++
  uploadingReference.value = false
  form.referenceDesign = undefined
}

onBeforeUnmount(() => {
  uploadSequence++
  descriptionSequence++
  descriptionController?.abort()
})

function pageDescriptionContext() {
  const parentNames = new Map(wb.pages.map((page) => [page.spec.id, page.spec.name]))
  return wb.pageRows.map(({ page, depth }) => ({
    name: page.spec.name,
    depth,
    groupOnly: !!page.spec.groupOnly,
    description:
      page.id === wb.selectedPageId
        ? undefined
        : (page.spec.description ?? '').trim().slice(0, 180),
    parentName: page.spec.parentId ? parentNames.get(page.spec.parentId) : undefined,
  }))
}

async function inferDescription() {
  const page = wb.selectedPage
  const project = wb.project
  if (!page || !project || descriptionGenerating.value) return
  const resolved = settings.resolveModel('generation', project.modelOverride)
  if (!resolved) {
    message.error('请先在设置中配置生成模型和 API Key')
    return
  }
  const pageId = page.id
  const projectId = project.id
  const requestId = ++descriptionSequence
  const controller = new AbortController()
  descriptionController?.abort()
  descriptionController = controller
  descriptionGenerating.value = true
  try {
    const parent = page.spec.parentId
      ? wb.pages.find((candidate) => candidate.spec.id === page.spec.parentId)
      : undefined
    const description = await inferPageDescription({
      ...resolved,
      projectName: project.name,
      iteration: project.iteration,
      overview: project.analysis?.overview,
      targetUsers: project.analysis?.targetUsers,
      platform: project.platform,
      currentPageName: page.spec.name,
      currentParentName: parent?.spec.name,
      pages: pageDescriptionContext(),
      currentDraft: form.description.trim() || undefined,
      signal: controller.signal,
    })
    if (requestId !== descriptionSequence || wb.project?.id !== projectId || wb.selectedPageId !== pageId)
      return
    form.description = description
    message.success('已生成页面描述，请检查后保存')
  } catch (error) {
    if (!controller.signal.aborted && requestId === descriptionSequence)
      message.error(error instanceof Error ? error.message : '页面描述生成失败，请重试')
  } finally {
    if (descriptionController === controller) {
      descriptionController = null
      descriptionGenerating.value = false
    }
  }
}

function requestInferDescription() {
  if (descriptionGenerating.value || saving.value) return
  if (!form.description.trim()) {
    void inferDescription()
    return
  }
  dialog.warning({
    title: '替换页面描述？',
    content: 'AI 推断结果会替换当前输入框中的描述，尚未保存的手动修改将被覆盖。',
    positiveText: '继续推断',
    negativeText: '取消',
    onPositiveClick: () => {
      void inferDescription()
    },
  })
}

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

const availableImportedPages = computed(() =>
  wb.pageRows
    .map(({ page }) => page)
    .filter(
      (page) =>
        page.id !== wb.selectedPageId &&
        !page.spec.groupOnly &&
        wb.htmlByPage.has(page.id) &&
        !form.importedPages?.some((item) => item.pageId === page.id),
    ),
)

function importedPageTreeOptions(currentPageId: string): TreeSelectOption[] {
  const pages = wb.pages
  const specIds = new Set(pages.map((page) => page.spec.id))
  const usedPageIds = new Set(
    (form.importedPages ?? [])
      .filter((item) => item.pageId !== currentPageId)
      .map((item) => item.pageId),
  )
  const children = new Map<string | undefined, Page[]>()
  for (const page of pages) {
    const parentId = specIds.has(page.spec.parentId ?? '') ? page.spec.parentId : undefined
    const siblings = children.get(parentId) ?? []
    siblings.push(page)
    children.set(parentId, siblings)
  }
  const visited = new Set<string>()
  const build = (page: Page, ancestors: Set<string>): TreeSelectOption => {
    visited.add(page.id)
    const nextAncestors = new Set(ancestors).add(page.spec.id)
    const nested = (children.get(page.spec.id) ?? [])
      .filter((child) => !nextAncestors.has(child.spec.id))
      .map((child) => build(child, nextAncestors))
    const hasContent = wb.htmlByPage.has(page.id)
    return {
      key: page.id,
      label: `${page.spec.name}${page.spec.groupOnly ? '（导航分组）' : hasContent ? '' : '（未生成）'}`,
      disabled:
        page.id === wb.selectedPageId ||
        page.spec.groupOnly ||
        !hasContent ||
        usedPageIds.has(page.id),
      ...(nested.length ? { children: nested } : {}),
    }
  }
  const roots = (children.get(undefined) ?? []).map((page) => build(page, new Set()))
  for (const page of pages) {
    if (!visited.has(page.id)) roots.push(build(page, new Set()))
  }
  return roots
}

function addImportedPage() {
  const page = availableImportedPages.value[0]
  if (!page) return
  const item: PageImportReference = {
    pageId: page.id,
    access: 'readonly',
    modificationRules: normalizePageImportModificationRules(),
  }
  form.importedPages = [...(form.importedPages ?? []), item]
}

function changeImportedPage(item: PageImportReference, pageId: string) {
  if (item.pageId === pageId) return
  item.pageId = pageId
  item.modificationRules = normalizePageImportModificationRules()
}

function removeImportedPage(index: number) {
  form.importedPages = (form.importedPages ?? []).filter((_, itemIndex) => itemIndex !== index)
  if (!form.importedPages.length && form.generationMode === 'from-import')
    form.generationMode = 'current'
}

function specKey(s: PageSpec): string {
  return JSON.stringify([
    s.name,
    s.parentId ?? '',
    !!s.groupOnly,
    s.description,
    s.blocks,
    s.referenceDesign,
    s.constraints,
    s.importedPages ?? [],
    s.generationMode ?? 'current',
  ])
}

const dirty = computed(() => {
  const spec = wb.selectedPage?.spec
  if (!spec) return false
  return specKey(spec) !== specKey({ ...form, parentId: parentChoice.value || undefined })
})

async function save(regenerate: boolean, confirmed = false) {
  if (saving.value || uploadingReference.value || (regenerate && generationLocked.value)) return
  if (regenerate && wb.selectedHtml && !confirmed) {
    dialog.warning({
      title: '确认保存并重新生成',
      content: '重新生成会覆盖当前页面现有的 AI 原型内容，但不会删除页面配置和历史版本。是否继续？',
      positiveText: '继续生成',
      negativeText: '取消',
      onPositiveClick: () => {
        void save(true, true)
      },
    })
    return
  }
  if (!form.name.trim()) {
    message.error('页面名不能为空')
    return
  }
  const spec: PageSpec = JSON.parse(
    JSON.stringify({ ...form, parentId: parentChoice.value || undefined }),
  ) as PageSpec
  if (spec.referenceDesign) {
    const value = spec.referenceDesign.innovation
    spec.referenceDesign.innovation = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.3))
  }
  if (spec.generationMode === 'from-import' && !spec.importedPages?.length) {
    message.error('基于引入页构建时，请至少添加一个引入页')
    return
  }
  const pageId = wb.selectedPageId
  const projectId = wb.project?.id
  saving.value = true
  try {
    if (!spec.groupOnly) buildGenerationConstraints(spec.constraints)
    await wb.updateSelectedSpec(spec)
    form.name = wb.selectedPage?.spec.name ?? spec.name
    message.success('已保存')
    if (
      regenerate &&
      !spec.groupOnly &&
      wb.project?.id === projectId &&
      wb.selectedPageId === pageId
    )
      wb.regenerateSelected()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存失败，请重试')
  } finally {
    saving.value = false
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
      <n-form label-placement="top" size="small" :disabled="saving">
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
        <n-form-item>
          <template #label>
            <div class="field-label">
              <span>页面描述</span>
              <n-button
                size="tiny"
                quaternary
                type="primary"
                :loading="descriptionGenerating"
                :disabled="saving || descriptionGenerating || !wb.selectedPage"
                @click="requestInferDescription"
              >
                AI 推断
              </n-button>
            </div>
          </template>
          <n-input v-model:value="form.description" type="textarea" :rows="3" />
        </n-form-item>
        <n-form-item v-if="!form.groupOnly" label="页面参考图">
          <div class="reference-design">
            <div v-if="form.referenceDesign" class="reference-row">
              <img
                class="reference-thumb"
                :src="referencePreview"
                :alt="form.referenceDesign.name"
              />
              <div class="reference-settings">
                <div class="reference-name" :title="form.referenceDesign.name">
                  {{ form.referenceDesign.name }}
                </div>
                <n-select
                  v-model:value="form.referenceDesign.mode"
                  :options="referenceModes"
                  :disabled="uploadingReference || saving"
                  size="small"
                  aria-label="参考图设计策略"
                />
                <n-space size="small" style="margin-top: 6px">
                  <n-button
                    size="tiny"
                    :disabled="uploadingReference || saving"
                    @click="referenceFile?.click()"
                    >更换</n-button
                  >
                  <n-button
                    size="tiny"
                    quaternary
                    :disabled="uploadingReference || saving"
                    @click="removeReference"
                    >移除</n-button
                  >
                </n-space>
              </div>
            </div>
            <n-button
              v-else
              size="small"
              block
              :loading="uploadingReference"
              :disabled="saving"
              @click="referenceFile?.click()"
            >
              上传一张参考图
            </n-button>
            <input
              ref="referenceFile"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style="display: none"
              @change="pickReference"
            />
            <template v-if="form.referenceDesign?.mode === 'creative'">
              <div class="innovation-heading">
                <span>创新值</span>
                <n-input-number
                  v-model:value="form.referenceDesign.innovation"
                  :min="0"
                  :max="1"
                  :step="0.05"
                  :precision="2"
                  :clearable="false"
                  :disabled="uploadingReference || saving"
                  size="tiny"
                  style="width: 100px"
                  aria-label="创新值，0 到 1"
                />
              </div>
              <n-slider
                v-model:value="form.referenceDesign.innovation"
                :min="0"
                :max="1"
                :step="0.05"
                :disabled="uploadingReference || saving"
                aria-label="参考图布局创新程度"
              />
              <n-text depth="3" class="reference-hint"
                >0 更忠实布局，1 更多布局创新；色调风格不变。</n-text
              >
            </template>
            <n-text depth="3" class="reference-hint">
              还原与创新均沿用项目及已有原型的风格色调。支持 PNG / JPG / WebP，单张不超过 10
              MB，需支持图片的生成模型。
            </n-text>
          </div>
        </n-form-item>
        <n-form-item v-if="!form.groupOnly" label="AI 生成约束">
          <PageConstraintEditor :key="form.id" v-model="form.constraints" :disabled="saving" />
        </n-form-item>
        <n-form-item v-if="!form.groupOnly" label="构建方式">
          <div class="generation-mode">
            <n-select
              v-model:value="form.generationMode"
              :options="generationModes"
              :disabled="saving"
            />
            <n-text depth="3" class="import-hint">
              {{
                form.generationMode === 'from-import'
                  ? '以首个引入页为视觉和结构基底，生成当前业务页。'
                  : form.generationMode === 'smart-related'
                    ? 'AI 可决定更新当前页、修改已授权引入页，或新增必要的关联逻辑页。'
                    : '只生成当前页面；引入页仅提供业务上下文。'
              }}
            </n-text>
          </div>
        </n-form-item>
        <n-form-item v-if="!form.groupOnly" label="引入页">
          <div class="imported-pages">
            <div
              v-for="(item, index) in form.importedPages ?? []"
              :key="index"
              class="imported-page-row"
              :class="{
                editable:
                  item.access === 'editable' ||
                  (form.generationMode === 'from-import' && index === 0),
              }"
            >
              <n-tree-select
                :value="item.pageId"
                :options="importedPageTreeOptions(item.pageId)"
                :disabled="saving"
                filterable
                show-line
                show-path
                separator=" › "
                placeholder="搜索或按层级选择页面"
                aria-label="选择引入页"
                @update:value="changeImportedPage(item, $event)"
              />
              <n-select
                v-model:value="item.access"
                :options="importAccessOptions"
                :disabled="saving || form.generationMode !== 'smart-related'"
                aria-label="引入页修改权限"
              />
              <ImportPageRulesEditor
                v-if="item.access === 'editable' || (form.generationMode === 'from-import' && index === 0)"
                v-model="item.modificationRules"
                :for-new-page="form.generationMode === 'from-import' && index === 0"
                :disabled="saving"
              />
              <n-button
                quaternary
                size="small"
                :disabled="saving"
                title="移除引入页"
                @click="removeImportedPage(index)"
              >
                ×
              </n-button>
            </div>
            <n-button
              size="small"
              dashed
              block
              :disabled="saving || !availableImportedPages.length"
              @click="addImportedPage"
            >
              + 添加引入页
            </n-button>
            <n-text depth="3" class="import-hint">
              引入页会自动携带给 AI 说明业务上下关系。可修改引入页默认保护框架和导航，点击“限制”可配置允许的修改范围；未配置的页面始终不能被修改。
            </n-text>
          </div>
        </n-form-item>
        <n-form-item label="内容区块（从上到下）">
          <n-dynamic-tags v-model:value="form.blocks" />
        </n-form-item>
      </n-form>
      <n-space vertical size="small">
        <n-button
          size="small"
          block
          :loading="saving"
          :disabled="!dirty || uploadingReference || saving || wb.hierarchySaving"
          @click="save(false)"
          >保存</n-button
        >
        <n-button
          size="small"
          block
          type="primary"
          secondary
          :loading="saving"
          :disabled="
            !!form.groupOnly ||
            uploadingReference ||
            saving ||
            generationLocked ||
            wb.hierarchySaving
          "
          @click="save(true)"
        >
          {{ wb.selectedHtml ? '保存并重新生成' : '保存并生成页面' }}
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

.field-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 8px;
}

.reference-design {
  width: 100%;
  min-width: 0;
}

.reference-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.reference-thumb {
  width: 72px;
  height: 88px;
  flex-shrink: 0;
  object-fit: contain;
  border: 1px solid var(--qp-border);
  border-radius: 6px;
}

.reference-settings {
  flex: 1;
  min-width: 0;
}

.reference-name {
  margin-bottom: 6px;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.innovation-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 12px 0 8px;
  font-size: 12px;
}

.reference-hint {
  display: block;
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.6;
}

.generation-mode,
.imported-pages {
  width: 100%;
  min-width: 0;
}

.imported-page-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 112px auto 28px;
  gap: 6px;
  align-items: center;
  margin-bottom: 7px;
}

.imported-page-row:not(.editable) {
  grid-template-columns: minmax(0, 1fr) 112px 28px;
}

.import-hint {
  display: block;
  margin-top: 7px;
  font-size: 11px;
  line-height: 1.6;
}
</style>
