<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { inspectLegacyStorage, migrateLegacyStorage, type LegacyMigrationResult, type LegacyStorageSummary } from '@/services/storage/legacyMigration'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  'update:show': [value: boolean]
  completed: [result: LegacyMigrationResult]
}>()
const message = useMessage()
const summary = ref<LegacyStorageSummary | null>(null)
const result = ref<LegacyMigrationResult | null>(null)
const loading = ref(false)
const migrating = ref(false)
const progress = ref(0)
const progressText = ref('')
const hasFailures = computed(() => !!result.value?.failedProjects.length)

async function refresh() {
  loading.value = true
  result.value = null
  progress.value = 0
  progressText.value = ''
  try {
    summary.value = await inspectLegacyStorage()
  } catch (error) {
    summary.value = null
    message.error(error instanceof Error ? error.message : '检测浏览器旧数据失败')
  } finally {
    loading.value = false
  }
}

async function startMigration() {
  if (migrating.value || !summary.value?.available) return
  migrating.value = true
  result.value = null
  try {
    const migrated = await migrateLegacyStorage((done, total, project) => {
      progress.value = total ? Math.round((done / total) * 100) : 0
      progressText.value = done < total ? `正在迁移：${project.name || project.id}` : '迁移完成，正在校验结果'
    })
    result.value = migrated
    progress.value = 100
    progressText.value = '迁移完成'
    emit('completed', migrated)
    if (migrated.failedProjects.length) message.warning('部分项目迁移失败，浏览器旧数据仍完整保留')
    else message.success(`已迁移 ${migrated.importedProjects} 个项目到 MySQL`)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '迁移失败')
  } finally {
    migrating.value = false
  }
}

watch(() => props.show, (show) => { if (show) void refresh() }, { immediate: true })
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="迁移浏览器旧数据到 MySQL"
    style="width: min(620px, calc(100vw - 32px))"
    :mask-closable="!migrating"
    :closable="!migrating"
    :close-on-esc="!migrating"
    @update:show="emit('update:show', $event)"
  >
    <n-spin :show="loading">
      <n-space vertical size="large">
        <n-alert type="info" :bordered="false">
          将旧版浏览器 IndexedDB 中的项目、页面、HTML 版本历史、源文档和图片资产写入 MySQL。迁移后不会删除浏览器旧数据，可继续作为本地备份。
        </n-alert>
        <n-descriptions v-if="summary" bordered :column="3" size="small">
          <n-descriptions-item label="项目">{{ summary.projects }}</n-descriptions-item>
          <n-descriptions-item label="页面">{{ summary.pages }}</n-descriptions-item>
          <n-descriptions-item label="版本历史">{{ summary.versions }}</n-descriptions-item>
          <n-descriptions-item label="源文档">{{ summary.docs }}</n-descriptions-item>
          <n-descriptions-item label="图片资产">{{ summary.assets }}</n-descriptions-item>
        </n-descriptions>
        <n-alert v-if="summary && !summary.available" type="warning" :bordered="false">
          当前浏览器未检测到可迁移的旧项目。请确认使用的是原来保存数据的同一浏览器和同一访问地址（例如一直使用 localhost:5173）。
        </n-alert>
        <template v-if="migrating || result">
          <n-progress type="line" :percentage="progress" :processing="migrating" />
          <n-text depth="3">{{ progressText }}</n-text>
        </template>
        <n-alert v-if="result" :type="hasFailures ? 'warning' : 'success'" :bordered="false">
          已导入 {{ result.importedProjects }} 个项目，跳过 {{ result.skippedProjects }} 个已存在项目；共写入 {{ result.pages }} 个页面、{{ result.versions }} 个版本、{{ result.docs }} 份文档和 {{ result.assets }} 个图片资产。
        </n-alert>
        <n-collapse v-if="result?.failedProjects.length">
          <n-collapse-item title="查看迁移失败项目" name="failures">
            <n-list bordered>
              <n-list-item v-for="item in result.failedProjects" :key="item.id">
                <n-thing :title="item.name" :description="item.error" />
              </n-list-item>
            </n-list>
          </n-collapse-item>
        </n-collapse>
      </n-space>
    </n-spin>
    <template #footer>
      <n-space justify="end">
        <n-button :disabled="migrating" @click="emit('update:show', false)">{{ result ? '关闭' : '暂不迁移' }}</n-button>
        <n-button type="primary" :loading="migrating" :disabled="loading || !summary?.available || !!result" @click="startMigration">
          开始迁移
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>
