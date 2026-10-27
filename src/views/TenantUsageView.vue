<script setup lang="ts">
import { h, onMounted, ref } from 'vue'
import { NTag, useMessage } from 'naive-ui'
import TenantAdminShell from '@/components/account/TenantAdminShell.vue'
import { saasApi } from '@/services/saas'

const message = useMessage()
const loading = ref(true)
const usage = ref<any>(null)

const channelColumns = [
  { title: '渠道归属', key: 'channelScope', render: (row: any) => h(NTag, { type: row.channelScope === 'platform' ? 'success' : 'info', bordered: false }, { default: () => row.channelScope === 'platform' ? '平台渠道' : '自有渠道' }) },
  { title: '服务商', key: 'provider' },
  { title: '模型', key: 'model' },
  { title: '调用次数', key: 'calls' },
  { title: '输入 Token', key: 'inputTokens' },
  { title: '输出 Token', key: 'outputTokens' },
  { title: '总 Token', key: 'totalTokens' },
]

const projectColumns = [
  { title: '项目', key: 'projectName' },
  { title: 'Token 消耗', key: 'totalTokens' },
  { title: '调用次数', key: 'calls' },
]

async function refresh() {
  loading.value = true
  try {
    usage.value = await saasApi.usage()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '用量数据加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <TenantAdminShell active="usage" title="用量使用情况" description="查看团队 AI Token 总量、渠道归属和各项目消耗。">
    <template #actions><n-button secondary :loading="loading" @click="refresh">刷新数据</n-button></template>
    <n-spin :show="loading">
      <div class="usage-stats">
        <n-card><n-statistic label="总 Token" :value="Number(usage?.totals?.totalTokens || 0)" /></n-card>
        <n-card><n-statistic label="输入 Token" :value="Number(usage?.totals?.inputTokens || 0)" /></n-card>
        <n-card><n-statistic label="输出 Token" :value="Number(usage?.totals?.outputTokens || 0)" /></n-card>
        <n-card><n-statistic label="调用次数" :value="Number(usage?.totals?.calls || 0)" /></n-card>
      </div>
      <n-card title="渠道消耗明细" class="usage-card">
        <n-data-table :columns="channelColumns" :data="usage?.channels || []" :scroll-x="900" />
      </n-card>
      <n-card title="项目消耗" class="usage-card">
        <n-data-table :columns="projectColumns" :data="usage?.projects || []" />
      </n-card>
    </n-spin>
  </TenantAdminShell>
</template>

<style scoped>
.usage-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px}.usage-card{margin-bottom:16px}
@media(max-width:900px){.usage-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){.usage-stats{grid-template-columns:1fr}}
</style>
