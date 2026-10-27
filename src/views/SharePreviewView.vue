<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { shareApi } from '@/services/sharing'
import { buildExportHtml } from '@/services/export/exportHtml'
import { buildRemarqExportHtml, remarqExportStorageKey } from '@/services/annotations/remarqDocument'
import { useAuthStore } from '@/stores/auth'
import type { PrototypeSharePayload, SharedPage } from '@/types/share'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const loading = ref(true)
const rendering = ref(false)
const error = ref('')
const payload = ref<PrototypeSharePayload | null>(null)
const selectedPageId = ref('')
const renderedHtml = ref('')
let renderSequence = 0

const code = computed(() => String(route.params.code ?? ''))
const selectedEntry = computed(() => {
  for (const iteration of payload.value?.iterations ?? []) {
    const page = iteration.pages.find((item) => item.id === selectedPageId.value && item.html)
    if (page) return { iteration, page }
  }
  return null
})
const totalPages = computed(() =>
  (payload.value?.iterations ?? []).reduce(
    (total, iteration) => total + iteration.pages.filter((page) => !!page.html).length,
    0,
  ),
)
const requiresLogin = computed(
  () => !auth.status?.authenticated && /登录|成员/.test(error.value),
)

function pageDepth(page: SharedPage, pages: SharedPage[]): number {
  const bySpecId = new Map(pages.map((item) => [item.spec.id, item]))
  let depth = 0
  let parentId = page.spec.parentId
  const seen = new Set<string>()
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = bySpecId.get(parentId)
    if (!parent) break
    depth++
    parentId = parent.spec.parentId
  }
  return Math.min(depth, 8)
}

function firstPageId(value: PrototypeSharePayload): string {
  for (const iteration of value.iterations) {
    const page = iteration.pages.find((item) => !!item.html)
    if (page) return page.id
  }
  return ''
}

async function loadShare(trackView: boolean) {
  if (!code.value) return
  loading.value = true
  try {
    const next = await shareApi.resolve(code.value, trackView)
    const changed = !payload.value || payload.value.revision !== next.revision
    const currentId = selectedPageId.value
    payload.value = next
    error.value = ''
    const currentStillExists = next.iterations.some((iteration) =>
      iteration.pages.some((page) => page.id === currentId && !!page.html),
    )
    if (!currentStillExists) selectedPageId.value = firstPageId(next)
    else if (changed) await renderSelected()
  } catch (loadError) {
    payload.value = null
    error.value = loadError instanceof Error ? loadError.message : '分享链接加载失败'
  } finally {
    loading.value = false
  }
}

async function renderSelected() {
  const entry = selectedEntry.value
  const share = payload.value
  const sequence = ++renderSequence
  if (!entry?.page.html || !share) {
    renderedHtml.value = ''
    return
  }
  rendering.value = true
  try {
    const base = await buildExportHtml(entry.page.html, entry.iteration.project.platform, true)
    if (sequence !== renderSequence || selectedEntry.value?.page.id !== entry.page.id) return
    renderedHtml.value = share.includeAnnotations
      ? buildRemarqExportHtml(base, entry.page.annotationStore, {
          storageKey: remarqExportStorageKey(`share-${share.code}`, entry.page.id, entry.page.annotationStore),
          theme: entry.iteration.project.styleSpec.tokens.colorMode,
        })
      : base
  } catch (renderError) {
    if (sequence === renderSequence)
      error.value = renderError instanceof Error ? renderError.message : '原型页面渲染失败'
  } finally {
    if (sequence === renderSequence) rendering.value = false
  }
}

function goLogin() {
  void router.push({ path: '/login', query: { redirect: route.fullPath } })
}

watch(selectedPageId, () => void renderSelected())
watch(code, () => void loadShare(true))

onMounted(() => void loadShare(true))
onBeforeUnmount(() => {
  renderSequence++
})
</script>

<template>
  <div class="share-preview">
    <div v-if="loading" class="share-state"><n-spin size="large" /></div>
    <div v-else-if="error && !payload" class="share-state">
      <n-result status="warning" title="无法查看分享" :description="error">
        <template #footer>
          <n-space justify="center">
            <n-button v-if="requiresLogin" type="primary" @click="goLogin">登录后查看</n-button>
            <n-button secondary @click="loadShare(true)">重新加载</n-button>
          </n-space>
        </template>
      </n-result>
    </div>
    <template v-else-if="payload">
      <header class="share-header">
        <div class="share-brand"><span>豆</span><strong>小豆原型</strong></div>
        <div class="share-title">
          <strong>{{ payload.iterations[0]?.project.name }}</strong>
          <small>设计原型（最终以 UI 效果为准）</small>
        </div>
      </header>
      <div class="share-workspace">
        <aside class="share-nav">
          <div class="nav-summary">页面层级 · {{ totalPages }} 个页面</div>
          <section v-for="iteration in payload.iterations" :key="iteration.project.id" class="iteration-group">
            <div v-if="payload.iterations.length > 1" class="iteration-title">
              {{ iteration.project.iteration }}
            </div>
            <button
              v-for="page in iteration.pages"
              :key="page.id"
              type="button"
              class="page-link"
              :class="{ active: selectedPageId === page.id, group: !page.html }"
              :style="{ paddingLeft: `${12 + pageDepth(page, iteration.pages) * 16}px` }"
              :disabled="!page.html"
              @click="page.html && (selectedPageId = page.id)"
            >
              <span>{{ page.html ? '▣' : '⌄' }}</span>
              <span>{{ page.spec.name }}</span>
            </button>
          </section>
        </aside>
        <main class="share-canvas">
          <n-spin :show="rendering" class="frame-spinner">
            <iframe
              v-if="renderedHtml"
              :srcdoc="renderedHtml"
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
              :title="selectedEntry?.page.spec.name ?? '原型预览'"
            />
            <n-empty v-else description="当前没有可显示的原型页面" />
          </n-spin>
        </main>
      </div>
    </template>
  </div>
</template>

<style scoped>
.share-preview {
  width: 100%;
  height: 100%;
  color: #18181b;
  background: #e4e4e7;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}

.share-state {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  background: #fff;
}

.share-header {
  height: 64px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 22px;
  border-bottom: 1px solid #e4e4e7;
  background: #fff;
}

.share-brand,
.share-title {
  display: flex;
  align-items: center;
}

.share-brand {
  gap: 8px;
  flex: 0 0 auto;
}

.share-brand > span {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: #fff;
  background: #4f46e5;
  font-weight: 700;
}

.share-title {
  min-width: 0;
  flex: 1;
  gap: 8px;
}

.share-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-title small,
.nav-summary {
  color: #71717a;
}

.share-workspace {
  height: calc(100% - 64px);
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
}

.share-nav {
  overflow: auto;
  padding: 16px 12px 28px;
  border-right: 1px solid #e4e4e7;
  background: #fff;
}

.nav-summary {
  margin: 0 8px 12px;
  font-size: 12px;
  font-weight: 600;
}

.iteration-group + .iteration-group {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #e4e4e7;
}

.iteration-title {
  margin: 0 8px 6px;
  color: #52525b;
  font-size: 12px;
  font-weight: 700;
}

.page-link {
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 5px;
  color: #27272a;
  background: transparent;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.page-link:hover:not(:disabled) {
  color: #4f46e5;
  background: #f4f4f5;
}

.page-link.active {
  color: #4338ca;
  background: #eef2ff;
  font-weight: 650;
}

.page-link.group {
  color: #52525b;
  font-weight: 650;
  cursor: default;
}

.share-canvas {
  min-width: 0;
  min-height: 0;
  padding: 12px;
}

.frame-spinner,
.frame-spinner :deep(.n-spin-container),
.frame-spinner :deep(.n-spin-content) {
  width: 100%;
  height: 100%;
}

iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, .08);
}

@media (max-width: 720px) {
  .share-header {
    height: 56px;
    gap: 10px;
    padding: 0 12px;
  }

  .share-brand strong,
  .share-title small {
    display: none;
  }

  .share-workspace {
    height: calc(100% - 56px);
    grid-template-columns: 170px minmax(0, 1fr);
  }

  .share-nav {
    padding: 12px 6px 20px;
  }

  .share-canvas {
    padding: 6px;
  }
}
</style>
