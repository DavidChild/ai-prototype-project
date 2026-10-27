<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useMessage } from 'naive-ui'
import type { ProviderConfig } from '@/types/provider'
import { useSettingsStore } from '@/stores/settings'
import { testProvider } from '@/services/llm/factory'
import { estimateUsage } from '@/services/storage/repositories'
import { formatBytes } from '@/utils/format'
import ProviderCard from '@/components/settings/ProviderCard.vue'
import ProviderForm from '@/components/settings/ProviderForm.vue'
import ModelSelect from '@/components/settings/ModelSelect.vue'
import LegacyMigrationDialog from '@/components/storage/LegacyMigrationDialog.vue'
import { useAuthStore } from '@/stores/auth'
import TenantAdminShell from '@/components/account/TenantAdminShell.vue'

const message = useMessage()
const route = useRoute()
const settings = useSettingsStore()
const auth = useAuthStore()

const formShow = ref(false)
const editingProvider = ref<ProviderConfig | null>(null)
const testingId = ref<string | null>(null)
const usageText = ref('')
const migrationShow = ref(false)
const showDataManagement = false
const section = computed<'providers' | 'models' | 'parameters'>(() => {
  if (route.path === '/settings/models') return 'models'
  if (route.path === '/settings/parameters') return 'parameters'
  return 'providers'
})
const pageMeta = computed(() => ({
  providers: { title: '服务商', description: '配置团队可用的平台通道和自有 AI 服务商。' },
  models: { title: '默认模型', description: '设置需求理解和页面生成默认使用的模型。' },
  parameters: { title: '生成参数', description: '调整原型生成过程的并发、Token 和采样参数。' },
}[section.value]))

function openCreate() {
  editingProvider.value = null
  formShow.value = true
}

function openEdit(provider: ProviderConfig) {
  editingProvider.value = provider
  formShow.value = true
}

async function onSaved(provider: ProviderConfig) {
  await settings.upsertProvider(provider)
  message.success('已保存')
}

async function handleTest(provider: ProviderConfig) {
  testingId.value = provider.id
  try {
    const { models } = await testProvider(provider)
    message.success(models.length ? `连接成功，可用模型 ${models.length} 个` : '连接成功')
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    testingId.value = null
  }
}

async function refreshUsage() {
  const usage = await estimateUsage()
  usageText.value = usage
    ? usage.quota > 0
      ? `已用 ${formatBytes(usage.usage)} / 配额约 ${formatBytes(usage.quota)}`
      : `MySQL 已用 ${formatBytes(usage.usage)}`
    : '数据库容量查询失败'
}

let selectionReady = false
watch(() => settings.modelSelection, () => { if (selectionReady) void settings.saveModelSelection().then(() => message.success('默认模型已保存')).catch((error) => message.error((error as Error).message)) }, { deep: true })
onMounted(async () => { await settings.loadTenantConfig(); selectionReady = true; if (showDataManagement) await refreshUsage() })
</script>

<template>
  <TenantAdminShell active="settings" :title="pageMeta.title" :description="pageMeta.description">
  <div class="settings-page">
    <template v-if="section === 'providers'">
    <n-h3>服务商</n-h3>
    <n-alert type="info" :bordered="false" style="margin-bottom: 16px">
      自有服务商配置归属当前企业或团队。平台通道由运营端开放，
      使用平台通道产生的 Token 计入平台渠道；使用自有通道则计入企业自己的渠道。
    </n-alert>
    <n-grid :cols="2" :x-gap="12" :y-gap="12">
      <n-grid-item v-for="p in settings.providers" :key="p.id">
        <ProviderCard
          :provider="p"
          :testing="testingId === p.id"
          @edit="openEdit(p)"
          @remove="settings.removeProvider(p.id)"
          @test="handleTest(p)"
        />
      </n-grid-item>
      <n-grid-item>
        <n-button dashed block style="height: 100%; min-height: 120px" @click="openCreate">
          + 添加服务商
        </n-button>
      </n-grid-item>
    </n-grid>
    </template>

    <template v-else-if="section === 'models'">
    <n-h3>默认模型</n-h3>
    <n-form label-placement="left" label-width="110">
      <n-form-item label="需求理解模型">
        <n-space vertical style="width: 100%" size="small">
          <ModelSelect v-model="settings.modelSelection.analysis" />
          <n-text depth="3" style="font-size: 12px">
            需求文档包含图片时，需选择支持视觉输入的模型
          </n-text>
        </n-space>
      </n-form-item>
      <n-form-item label="页面生成模型">
        <ModelSelect v-model="settings.modelSelection.generation" />
      </n-form-item>
    </n-form>
    </template>

    <template v-else>
    <n-h3>生成参数</n-h3>
    <n-form label-placement="left" label-width="110">
      <n-form-item label="并发数">
        <n-slider
          v-model:value="settings.genParams.concurrency"
          :min="1"
          :max="5"
          :step="1"
          :marks="{ 1: '1', 3: '3', 5: '5' }"
          style="max-width: 320px"
        />
      </n-form-item>
      <n-form-item label="生成 maxTokens">
        <n-input-number
          v-model:value="settings.genParams.maxTokens"
          :min="4000"
          :max="64000"
          :step="1000"
          style="width: 200px"
        />
      </n-form-item>
      <n-form-item label="温度">
        <n-slider
          v-model:value="settings.genParams.temperature"
          :min="0"
          :max="1.5"
          :step="0.1"
          style="max-width: 320px"
        />
      </n-form-item>
      <n-form-item label="理解输入预算">
        <n-space align="center">
          <n-input-number
            v-model:value="settings.genParams.analysisInputBudget"
            :min="8000"
            :max="128000"
            :step="4000"
            style="width: 200px"
          />
          <n-text depth="3" style="font-size: 12px">tokens，超出将结构化截断文档</n-text>
        </n-space>
      </n-form-item>
      <n-form-item label="Tailwind CDN">
        <n-input
          v-model:value="settings.genParams.tailwindCdnUrl"
          placeholder="https://cdn.tailwindcss.com"
          style="max-width: 420px"
        />
      </n-form-item>
    </n-form>
    </template>

    <template v-if="showDataManagement">
      <n-h3>数据管理</n-h3>
      <n-space align="center">
        <n-text depth="2">{{ usageText }}</n-text>
        <n-button size="small" quaternary @click="refreshUsage">刷新</n-button>
        <n-button v-if="auth.isAdmin" size="small" type="primary" secondary @click="migrationShow = true">
          迁移浏览器旧数据
        </n-button>
      </n-space>
    </template>

    <ProviderForm v-model:show="formShow" :provider="editingProvider" :allowed-models="settings.allowedModels" :allowed-preset-models="settings.allowedPresetModels" @saved="onSaved" />
    <LegacyMigrationDialog v-if="showDataManagement" v-model:show="migrationShow" @completed="refreshUsage" />
  </div>
  </TenantAdminShell>
</template>

<style scoped>
.settings-page {
  max-width: 980px;
}
</style>
