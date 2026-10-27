<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useWorkbenchStore } from '@/stores/workbench'
import { buildPagePng } from '@/services/export/screenshot'
import { buildExportHtml } from '@/services/export/exportHtml'
import { buildProjectZip } from '@/services/export/exportZip'
import { buildPrototypeIndexHtml } from '@/services/export/prototypeIndex'
import {
  chooseExportDirectory,
  ensureExportDirectory,
  getExportDirectoryName,
  isDirectorySelectionCanceled,
  writeExportFile,
} from '@/services/export/exportDirectory'
import { sanitizeFileName } from '@/utils/download'
import { searchPageTreeRows } from '@/utils/pageTree'
import type { Page } from '@/types/page'
import type { Project } from '@/types/project'
import {
  buildRemarqExportHtml,
  remarqExportStorageKey,
} from '@/services/annotations/remarqDocument'

const wb = useWorkbenchStore()
const message = useMessage()
const dialog = useDialog()
const exporting = ref(false)
const directoryName = ref('')
let directorySequence = 0

const searchResult = computed(() => searchPageTreeRows(wb.pageRows, wb.pageSearchQuery))
const searchedPages = computed(() =>
  wb.pageRows
    .map(({ page }) => page)
    .filter(
      (page) =>
        searchResult.value.matchedIds.has(page.spec.id) &&
        !page.spec.groupOnly &&
        wb.htmlByPage.has(page.id),
    ),
)
const explicitlySelectedPages = computed(() => {
  const selected = new Set(wb.exportSelectedPageIds)
  return wb.pageRows
    .map(({ page }) => page)
    .filter((page) => selected.has(page.id) && !page.spec.groupOnly && wb.htmlByPage.has(page.id))
})
const effectiveSelectedPages = computed(() => {
  if (explicitlySelectedPages.value.length) return explicitlySelectedPages.value
  const page = wb.selectedPage
  return page && !page.spec.groupOnly && wb.htmlByPage.has(page.id) ? [page] : []
})

const options = computed(() => [
  {
    label: `已选页面 HTML（带层级，${effectiveSelectedPages.value.length} 页）`,
    key: 'selected-html-tree',
    disabled: !effectiveSelectedPages.value.length,
  },
  {
    label: `已选页面 PNG（2x，${effectiveSelectedPages.value.length} 页）`,
    key: 'selected-png',
    disabled: !effectiveSelectedPages.value.length,
  },
  {
    label: `已选页面 HTML（不带层级，${effectiveSelectedPages.value.length} 页）`,
    key: 'selected-html-flat',
    disabled: !effectiveSelectedPages.value.length,
  },
  {
    label: wb.pageSearchQuery.trim()
      ? `当前搜索 HTML（带层级，${searchedPages.value.length} 页）`
      : '当前搜索 HTML（请先搜索）',
    key: 'search-html-tree',
    disabled: !wb.pageSearchQuery.trim() || !searchedPages.value.length,
  },
  { type: 'divider', key: 'export-divider' },
  {
    label: '整项目 ZIP',
    key: 'project-zip',
    disabled: !wb.pages.some((page) => !page.spec.groupOnly && wb.htmlByPage.has(page.id)),
  },
  { type: 'divider', key: 'directory-divider' },
  {
    label: `保存目录：${directoryName.value || '首次导出时选择'}`,
    key: 'directory-label',
    disabled: true,
  },
  { label: directoryName.value ? '更换保存目录' : '选择保存目录', key: 'choose-directory' },
])

watch(
  () => wb.project?.id,
  async (projectId) => {
    const sequence = ++directorySequence
    directoryName.value = ''
    if (!projectId) return
    const name = await getExportDirectoryName(projectId)
    if (sequence === directorySequence && wb.project?.id === projectId) directoryName.value = name
  },
  { immediate: true },
)

function uniquePageSegment(page: Page): string {
  const siblings = wb.pages.filter(
    (candidate) => (candidate.spec.parentId ?? '') === (page.spec.parentId ?? ''),
  )
  const index = siblings.findIndex((candidate) => candidate.id === page.id)
  const base = sanitizeFileName(page.spec.name)
  const occurrence = siblings
    .slice(0, index + 1)
    .filter((candidate) => sanitizeFileName(candidate.spec.name) === base).length
  return occurrence > 1 ? `${base}-${occurrence}` : base
}

function pageFilePath(page: Page, extension: 'html' | 'png', hierarchical: boolean): string[] {
  if (!hierarchical) return [`${uniquePageSegment(page)}.${extension}`]
  const chain: Page[] = []
  const seen = new Set<string>()
  let current: Page | undefined = page
  while (current && !seen.has(current.spec.id)) {
    seen.add(current.spec.id)
    chain.unshift(current)
    const parentId: string | undefined = current.spec.parentId
    current = parentId ? wb.pages.find((candidate) => candidate.spec.id === parentId) : undefined
  }
  const segments = chain.map(uniquePageSegment)
  const file = segments.pop() ?? uniquePageSegment(page)
  return [...segments, `${file}.${extension}`]
}

function flatPageFileName(
  page: Page,
  extension: 'html' | 'png',
  selectedPages: readonly Page[],
): string {
  const base = sanitizeFileName(page.spec.name)
  const index = selectedPages.findIndex((candidate) => candidate.id === page.id)
  const occurrence = selectedPages
    .slice(0, index + 1)
    .filter((candidate) => sanitizeFileName(candidate.spec.name) === base).length
  return `${base}${occurrence > 1 ? `-${occurrence}` : ''}.${extension}`
}

async function chooseDirectory() {
  const projectId = wb.project?.id
  if (!projectId || exporting.value) return
  try {
    const directory = await chooseExportDirectory(projectId)
    if (wb.project?.id === projectId) directoryName.value = directory.name
    message.success(`保存目录已设为「${directory.name}」，后续导出将直接覆盖同名文件`)
  } catch (error) {
    if (!isDirectorySelectionCanceled(error))
      message.error(error instanceof Error ? error.message : '选择保存目录失败')
  }
}

async function writeHierarchicalHtml(
  directory: FileSystemDirectoryHandle,
  pages: readonly Page[],
  project: Project,
  progressLabel: string,
  updateProgress: (content: string) => void,
  includeAnnotations: boolean,
) {
  const entries: { page: Page; path: string[] }[] = []
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!
    updateProgress(`${progressLabel} ${index + 1}/${pages.length} 页`)
    const html = await buildPageExportHtml(page, project, includeAnnotations)
    const path = pageFilePath(page, 'html', true)
    await writeExportFile(directory, path, html)
    entries.push({ page, path })
  }
  updateProgress('正在生成原型层级索引…')
  const indexHtml = buildPrototypeIndexHtml(project, wb.pages, entries)
  await writeExportFile(directory, ['proto_index.html'], indexHtml)
}

async function buildPageExportHtml(
  page: Page,
  project: Project,
  includeAnnotations: boolean,
): Promise<string> {
  const html = await buildExportHtml(wb.htmlByPage.get(page.id)!, project.platform, true)
  return includeAnnotations
    ? buildRemarqExportHtml(html, page.annotationStore, {
        storageKey: remarqExportStorageKey(project.id, page.id, page.annotationStore),
        theme: project.styleSpec.tokens.colorMode,
      })
    : html
}

function handle(key: string | number) {
  if (key === 'choose-directory') return void chooseDirectory()
  if (exporting.value) return
  dialog.info({
    title: '是否携带原型标注？',
    content: '带标注导出会内嵌 web-remarq 标注、标记点和查看工具；不带标注则只导出原型页面。',
    positiveText: '带标注导出',
    negativeText: '不带标注导出',
    onPositiveClick: () => performExport(key, true),
    onNegativeClick: () => performExport(key, false),
  })
}

async function performExport(key: string | number, includeAnnotations: boolean) {
  const project = wb.project
  if (!project || exporting.value) return
  const selectedPages = [...effectiveSelectedPages.value]
  exporting.value = true
  let loading: ReturnType<typeof message.loading> | undefined
  try {
    const directory = await ensureExportDirectory(project.id)
    if (wb.project?.id !== project.id) throw new Error('项目已切换，请重新导出')
    directoryName.value = directory.name
    loading = message.loading('正在导出…', { duration: 0 })
    const updateProgress = (content: string) => {
      if (loading) loading.content = content
    }

    if (key === 'selected-png' && selectedPages.length) {
      const background = project.styleSpec.tokens.colorMode === 'dark' ? '#0b0b0e' : '#ffffff'
      for (let index = 0; index < selectedPages.length; index++) {
        const page = selectedPages[index]!
        loading.content = `正在导出已选 PNG… ${index + 1}/${selectedPages.length} 页`
        const source = includeAnnotations
          ? await buildPageExportHtml(page, project, true)
          : wb.htmlByPage.get(page.id)!
        const blob = await buildPagePng(source, project.platform, background)
        await writeExportFile(directory, [flatPageFileName(page, 'png', selectedPages)], blob)
      }
    } else if (key === 'selected-html-flat' && selectedPages.length) {
      for (let index = 0; index < selectedPages.length; index++) {
        const page = selectedPages[index]!
        loading.content = `正在导出已选 HTML… ${index + 1}/${selectedPages.length} 页`
        const html = await buildPageExportHtml(page, project, includeAnnotations)
        await writeExportFile(directory, [flatPageFileName(page, 'html', selectedPages)], html)
      }
    } else if (key === 'selected-html-tree' && selectedPages.length) {
      await writeHierarchicalHtml(
        directory,
        selectedPages,
        project,
        '正在按层级导出…',
        updateProgress,
        includeAnnotations,
      )
    } else if (key === 'search-html-tree') {
      const pages = [...searchedPages.value]
      if (!wb.pageSearchQuery.trim() || !pages.length) throw new Error('当前搜索没有可导出的页面')
      await writeHierarchicalHtml(
        directory,
        pages,
        project,
        '正在导出搜索结果…',
        updateProgress,
        includeAnnotations,
      )
    } else if (key === 'project-zip') {
      const nameBySpecId = new Map(wb.pages.map((page) => [page.spec.id, page.spec.name]))
      const items = wb.pages
        .filter((page) => !page.spec.groupOnly && wb.htmlByPage.has(page.id))
        .map((page) => ({
          page,
          html: wb.htmlByPage.get(page.id)!,
          groupName: page.spec.parentId
            ? (nameBySpecId.get(page.spec.parentId) ?? '未分组')
            : page.spec.name,
        }))
      const blob = await buildProjectZip(project, items, {
        inlineTailwind: true,
        includeAnnotations,
        onProgress: (done, total) => {
          if (loading) loading.content = `正在导出项目… ${done}/${total} 页`
        },
      })
      await writeExportFile(directory, [`${sanitizeFileName(project.name)}-UI设计.zip`], blob)
    } else {
      throw new Error('请选择有效的导出方式')
    }
    const includesPrototypeIndex = key === 'selected-html-tree' || key === 'search-html-tree'
    message.success(
      includesPrototypeIndex
        ? `已导出到「${directory.name}」，请打开 proto_index.html 查看，同名文件已直接覆盖`
        : `已导出到「${directory.name}」，同名文件已直接覆盖`,
    )
  } catch (error) {
    if (!isDirectorySelectionCanceled(error))
      message.error(`导出失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    loading?.destroy()
    exporting.value = false
  }
}
</script>

<template>
  <n-dropdown trigger="click" :options="options" @select="handle">
    <n-button
      size="small"
      secondary
      :loading="exporting"
      :title="directoryName ? `导出到：${directoryName}` : '首次导出时选择保存目录'"
    >
      导出{{ explicitlySelectedPages.length ? ` (${explicitlySelectedPages.length})` : '' }}
    </n-button>
  </n-dropdown>
</template>
