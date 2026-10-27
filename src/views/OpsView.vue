<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, resolveComponent } from 'vue'
import { useRouter } from 'vue-router'
import { useDialog, useMessage } from 'naive-ui'
import { opsApi } from '@/services/saas'
import AccountSettingsDialog from '@/components/account/AccountSettingsDialog.vue'
import ProviderForm from '@/components/settings/ProviderForm.vue'
import ProviderCard from '@/components/settings/ProviderCard.vue'
import type { ProviderConfig } from '@/types/provider'
import { testProvider } from '@/services/llm/factory'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'

const router = useRouter(), message = useMessage(), dialog = useDialog()
const auth = useAuthStore(), settings = useSettingsStore()
const section = ref<'overview' | 'tenants' | 'models'>('overview')
const operatorInitial = computed(() => (auth.user?.displayName || auth.user?.email || 'O').trim().slice(0, 1).toUpperCase())
async function logout() { await auth.logout(); await router.push('/login') }
const data = ref<any>(null), loading = ref(true), show = ref(false), saving = ref(false)
const detailShow = ref(false), detailLoading = ref(false), detail = ref<any>(null)
const accountSettingsShow = ref(false)
const aiProviders = ref<ProviderConfig[]>([]), aiProviderShow = ref(false), editingAiProvider = ref<ProviderConfig | null>(null)
const testingAiId = ref<string | null>(null)
type ModelPoolItem = { id: string; providerPresetId: string; providerName: string; protocol: string; model: string }
const modelPool = ref<ModelPoolItem[]>([]), allowedAiModelIds = ref<string[]>([]), allModelsEnabled = ref(false), savingAllowedModels = ref(false)
const modelPoolOptions = computed(() => modelPool.value.map((item) => ({ label: `${item.providerName} / ${item.model}`, value: item.id })))
const form = reactive({ name: '', username: '', displayName: '', email: '', password: '' })
async function refresh() { loading.value = true; try { const [summary,providers,models]=await Promise.all([opsApi.summary(),opsApi.aiProviders(),opsApi.allowedAiModels()]);data.value=summary;aiProviders.value=providers;modelPool.value=models.pool;allowedAiModelIds.value=models.selectedIds;allModelsEnabled.value=models.allModelsEnabled } finally { loading.value = false } }
async function saveAllowedModels() { savingAllowedModels.value=true; try { await opsApi.saveAllowedAiModels(allowedAiModelIds.value,allModelsEnabled.value); message.success(allModelsEnabled.value?'已向租户开放模型池中的全部模型':'已按模型池选择范围限制租户可用模型') } catch(error) { message.error(error instanceof Error ? error.message : '保存失败') } finally { savingAllowedModels.value=false } }
function openAiProvider(provider: ProviderConfig | null = null) { editingAiProvider.value = provider; aiProviderShow.value = true }
async function saveAiProvider(provider: ProviderConfig) { await opsApi.saveAiProvider(provider); aiProviders.value = await opsApi.aiProviders(); message.success('平台模型通道已保存并向租户开放') }
async function removeAiProvider(id: string) { await opsApi.removeAiProvider(id); aiProviders.value = await opsApi.aiProviders(); message.success('平台模型通道已移除') }
async function testAiProvider(provider: ProviderConfig) { testingAiId.value=provider.id; try { const result=await testProvider(provider); message.success(result.models.length ? `连接成功，可用模型 ${result.models.length} 个` : '连接成功') } catch(error) { message.error(error instanceof Error ? error.message : '连接失败') } finally { testingAiId.value=null } }
function createRandomPassword() {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*_-']
  const randomIndex = (length: number) => {
    const value = new Uint32Array(1)
    crypto.getRandomValues(value)
    return value[0]! % length
  }
  const password = groups.map((group) => group[randomIndex(group.length)]!)
  const all = groups.join('')
  while (password.length < 12) password.push(all[randomIndex(all.length)]!)
  for (let index = password.length - 1; index > 0; index -= 1) {
    const target = randomIndex(index + 1)
    ;[password[index], password[target]] = [password[target]!, password[index]!]
  }
  return password.join('')
}
function generatePassword() { form.password = createRandomPassword(); message.success('已生成 12 位初始密码') }
async function copyInitialPassword() { if (!form.password) return; await navigator.clipboard.writeText(form.password); message.success('初始密码已复制') }
async function copyAccountInfo(row: any) {
  if (!row.adminUserId) { message.error('该企业未找到管理员账号'); return }
  try {
    const credential = await opsApi.tenantAdminCredential(row.id, row.adminUserId)
    const content = [
      '企业名称：' + row.name,
      '管理员：' + (row.adminDisplayName || '未设置'),
      '角色：管理员',
      '登录账号：' + (row.adminUsername || '未设置'),
      '邮箱：' + (row.adminEmail || '未设置'),
      '密码：' + credential.password,
      '账号状态：' + (row.status === 'active' ? '正常' : '已暂停'),
    ].join('\n')
    await navigator.clipboard.writeText(content)
    message.success('账号和密码信息已复制')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '账号信息复制失败')
  }
}
function resetAdminPassword(row: any) {
  if (!row.adminUserId) { message.error('该企业未找到管理员账号'); return }
  dialog.warning({
    title: '重置管理员密码',
    content: '确定重置企业“' + row.name + '”管理员账号的密码吗？重置后原密码立即失效。',
    positiveText: '确认重置',
    negativeText: '取消',
    async onPositiveClick() {
      try {
        const password = createRandomPassword()
        await opsApi.resetTenantAdminPassword(row.id, row.adminUserId, password)
        await navigator.clipboard.writeText(password)
        dialog.success({ title: '密码已重置', content: '新的临时密码：' + password + '\n\n密码已自动复制，请单独发送给管理员。', positiveText: '知道了' })
      } catch (error) {
        message.error(error instanceof Error ? error.message : '密码重置失败')
        return false
      }
    },
  })
}
function toggle(row: any) {
  const suspending = row.status === 'active'
  dialog.warning({
    title: suspending ? '暂停企业或团队' : '启用企业或团队',
    content: suspending
      ? '确定暂停企业或团队“' + row.name + '”吗？暂停后，该企业或团队下的成员将无法登录和访问项目。'
      : '确定启用企业或团队“' + row.name + '”吗？启用后，其成员将恢复登录和项目访问权限。',
    positiveText: suspending ? '确认暂停' : '确认启用',
    negativeText: '取消',
    async onPositiveClick() {
      try {
        await opsApi.updateTenant(row.id, row.name, suspending ? 'suspended' : 'active')
        await refresh()
        message.success('企业或团队“' + row.name + '”已' + (suspending ? '暂停' : '启用'))
      } catch (error) {
        message.error(error instanceof Error ? error.message : '操作失败')
        return false
      }
    },
  })
}
async function createTenant() { saving.value = true; try { await opsApi.createTenant(form); show.value = false; Object.assign(form, { name: '', username: '', displayName: '', email: '', password: '' }); await refresh(); message.success('入住用户已创建') } catch (error) { message.error(error instanceof Error ? error.message : '创建失败') } finally { saving.value = false } }
async function openDetail(row: any) { detailShow.value = true; detailLoading.value = true; detail.value = null; try { detail.value = await opsApi.tenantDetail(row.id) } catch (error) { message.error(error instanceof Error ? error.message : '企业明细加载失败') } finally { detailLoading.value = false } }
const columns = [
  { title: '企业名称', key: 'name' }, { title: '成员', key: 'memberCount' }, { title: '设计项目', key: 'projectCount' },
  { title: '迭代版本', key: 'iterationCount' }, { title: '页面', key: 'pageCount' }, { title: '修改次数', key: 'modificationCount' },
  { title: 'AI Token', key: 'totalTokens' }, { title: '最近登录', key: 'lastLoginAt', render: (row: any) => row.lastLoginAt ? new Date(Number(row.lastLoginAt)).toLocaleString() : '尚未登录' },
  { title: '状态', key: 'status', render: (row: any) => h(resolveComponent('NTag'), { type: row.status === 'active' ? 'success' : 'warning', bordered: false }, () => row.status === 'active' ? '正常' : '已暂停') },
  { title: '账号信息', key: 'accountInfo', render: (row: any) => h(resolveComponent('NButton'), { size: 'small', secondary: true, type: 'primary', onClick: () => copyAccountInfo(row) }, () => '复制账号信息') },
  { title: '操作', key: 'actions', render: (row: any) => h('div', { class: 'row-actions' }, [
    h(resolveComponent('NButton'), { size: 'small', onClick: () => openDetail(row) }, () => '查看统计'),
    h(resolveComponent('NButton'), { size: 'small', secondary: true, onClick: () => resetAdminPassword(row) }, () => '重置密码'),
    h(resolveComponent('NButton'), { size: 'small', type: row.status === 'active' ? 'warning' : 'success', onClick: () => toggle(row) }, () => row.status === 'active' ? '暂停' : '启用'),
  ]) },
]
const projectColumns = [
  { title: '项目', key: 'projectName' }, { title: '迭代版本数', key: 'iterationCount' }, { title: '迭代版本', key: 'iterations' },
  { title: '页面数', key: 'pageCount' }, { title: '页面历史版本', key: 'contentVersionCount' },
  { title: '修改次数', key: 'modificationCount' }, { title: 'AI Token', key: 'totalTokens' },
]
const usageDetailColumns = [
  { title: '调用类型', key: 'operation' },
  { title: '渠道归属', key: 'channelScope', render: (row: any) => h(resolveComponent('NTag'), { type: row.channelScope === 'platform' ? 'success' : 'info', bordered: false }, () => row.channelScope === 'platform' ? '平台渠道' : '自有渠道') },
  { title: '服务商', key: 'provider' }, { title: '模型', key: 'model' }, { title: '调用次数', key: 'calls' }, { title: '输入 Token', key: 'inputTokens' }, { title: '输出 Token', key: 'outputTokens' }, { title: '总 Token', key: 'totalTokens' },
]
onMounted(refresh)
</script>
<template>
  <div class="ops-shell">
    <aside class="ops-sidebar">
      <div class="ops-brand"><span class="ops-brand-mark">豆</span><div><strong>小豆原型</strong><small>平台运营中心</small></div></div>
      <nav class="ops-nav" aria-label="平台运营导航">
        <button :class="{ active: section === 'overview' }" @click="section = 'overview'"><span>▦</span><b>平台总览</b></button>
        <button :class="{ active: section === 'tenants' }" @click="section = 'tenants'"><span>♙</span><b>入住用户</b><em>{{ Number(data?.totals?.tenants || 0) }}</em></button>
        <button :class="{ active: section === 'models' }" @click="section = 'models'"><span>⚙</span><b>模型设置</b></button>
      </nav>
      <div class="ops-account"><n-avatar round size="medium">{{ operatorInitial }}</n-avatar><div><strong>{{ auth.user?.displayName || '平台管理员' }}</strong><span>平台运营管理者</span></div></div>
    </aside>
    <main class="ops-main">
      <header class="ops-topbar">
        <div><strong>{{ section === 'overview' ? '平台总览' : section === 'tenants' ? '入住用户管理' : '平台模型设置' }}</strong><span>统一管理平台企业、项目使用与 AI 模型能力</span></div>
        <n-space><n-button secondary @click="accountSettingsShow = true">账号设置</n-button><n-button secondary :title="settings.appTheme === 'dark' ? '切换到浅色' : '切换到深色'" @click="settings.toggleAppTheme()">{{ settings.appTheme === 'dark' ? '🌙' : '☀️' }}</n-button><n-button quaternary @click="logout">退出登录</n-button><n-button v-if="section === 'tenants'" type="primary" @click="show = true">新增入住用户</n-button></n-space>
      </header>
      <div class="ops-content">
        <section v-if="section === 'overview'">
          <div class="ops-heading"><span>PLATFORM OVERVIEW</span><h1>平台运营总览</h1><p>查看企业入驻、设计项目、页面产出和 AI Token 消耗情况。</p></div>
          <n-spin :show="loading"><div class="totals"><n-card><n-statistic label="入驻企业" :value="Number(data?.totals?.tenants || 0)" /></n-card><n-card><n-statistic label="平台账号" :value="Number(data?.totals?.users || 0)" /></n-card><n-card><n-statistic label="设计项目" :value="Number(data?.totals?.projects || 0)" /></n-card><n-card><n-statistic label="迭代版本" :value="Number(data?.totals?.iterations || 0)" /></n-card><n-card><n-statistic label="原型页面" :value="Number(data?.totals?.pages || 0)" /></n-card><n-card><n-statistic label="修改次数" :value="Number(data?.totals?.modifications || 0)" /></n-card><n-card><n-statistic label="平台总 Token" :value="Number(data?.totals?.totalTokens || 0)" /></n-card></div></n-spin>
          <n-card title="企业使用概览"><n-data-table :columns="columns" :data="data?.tenants || []" :scroll-x="1500" /></n-card>
        </section>
        <section v-else-if="section === 'tenants'">
          <div class="ops-heading"><span>TENANT MANAGEMENT</span><h1>入住用户</h1><p>管理企业或团队账号、状态、项目产出和管理员信息。</p></div>
          <n-spin :show="loading"><n-data-table :columns="columns" :data="data?.tenants || []" :scroll-x="1500" /></n-spin>
        </section>
        <section v-else>
          <div class="ops-heading"><span>MODEL SETTINGS</span><h1>平台模型设置</h1><p>维护平台模型通道，并决定向企业开放的模型范围。</p></div>
          <n-card title="平台 AI 模型通道"><template #header-extra><n-button type="primary" secondary @click="openAiProvider()">新增平台通道</n-button></template><n-alert type="info" :bordered="false" style="margin-bottom:14px">平台可统一开放模型池中的全部模型，也可以关闭全部开放后，仅向租户开放指定模型。平台通道产生的 Token 记为平台渠道。</n-alert><n-form label-placement="left" label-width="120" style="margin-bottom:16px"><n-form-item label="全部模型开放"><n-space align="center"><n-switch v-model:value="allModelsEnabled" /><n-text :type="allModelsEnabled ? 'success' : 'default'">{{ allModelsEnabled ? '已启用，租户可选择模型池中的所有模型' : '已关闭，按下方模型选择范围开放' }}</n-text></n-space></n-form-item><n-form-item label="从模型池选择"><n-space vertical style="width:100%"><n-select v-model:value="allowedAiModelIds" multiple filterable clearable :disabled="allModelsEnabled" :options="modelPoolOptions" placeholder="搜索服务商或模型名称，选择允许租户使用的模型" max-tag-count="responsive" /><n-space justify="space-between" align="center"><n-text depth="3">模型池已收录 {{ modelPool.length }} 个预设及平台通道模型，{{ allModelsEnabled ? '当前全部开放' : '当前指定开放 ' + allowedAiModelIds.length + ' 个' }}。</n-text><n-button type="primary" :loading="savingAllowedModels" @click="saveAllowedModels">保存开放策略</n-button></n-space></n-space></n-form-item></n-form><n-grid :cols="2" :x-gap="12" :y-gap="12"><n-grid-item v-for="provider in aiProviders" :key="provider.id"><ProviderCard :provider="provider" :testing="testingAiId === provider.id" manageable @test="testAiProvider(provider)" @edit="openAiProvider(provider)" @remove="removeAiProvider(provider.id)" /></n-grid-item></n-grid></n-card>
        </section>
      </div>
    </main>
    <AccountSettingsDialog v-model:show="accountSettingsShow" />
    <n-modal v-model:show="detailShow" preset="card" :title="detail?.tenant?.name ? `${detail.tenant.name} · 使用明细` : '企业使用明细'" style="width:min(1180px,96vw)">
      <n-spin :show="detailLoading"><n-empty v-if="!detailLoading && !detail" description="没有可展示的数据" /><template v-else-if="detail"><n-h3>项目、版本与修改统计</n-h3><n-data-table :columns="projectColumns" :data="detail.projects" :scroll-x="1050" /><n-h3>AI Token 渠道与调用明细</n-h3><n-data-table :columns="usageDetailColumns" :data="detail.usageByOperation" :scroll-x="1100" /></template></n-spin>
    </n-modal>
    <n-modal v-model:show="show" preset="card" title="新增入住用户" style="width:500px"><n-form label-placement="top"><n-form-item label="企业名称"><n-input v-model:value="form.name" /></n-form-item><n-form-item label="管理员姓名"><n-input v-model:value="form.displayName" /></n-form-item><n-form-item label="登录账号"><n-input v-model:value="form.username" maxlength="48" placeholder="字母、数字、点、下划线或短横线" /></n-form-item><n-form-item label="管理员邮箱"><n-input v-model:value="form.email" /></n-form-item><n-form-item label="初始密码"><div class="password-field"><n-input-group><n-input v-model:value="form.password" type="password" show-password-on="click" placeholder="至少 8 位，可手动输入或自动生成" /><n-button @click="generatePassword">自动生成</n-button><n-button :disabled="!form.password" @click="copyInitialPassword">复制</n-button></n-input-group><n-text depth="3" class="password-tip">自动生成的密码包含大小写字母、数字和特殊字符。</n-text></div></n-form-item></n-form><template #footer><n-space justify="end"><n-button @click="show = false">取消</n-button><n-button type="primary" :loading="saving" :disabled="!form.name.trim() || !form.username.trim() || !form.displayName.trim() || !form.email.trim() || form.password.length < 8" @click="createTenant">创建</n-button></n-space></template></n-modal>
    <ProviderForm v-model:show="aiProviderShow" :provider="editingAiProvider" @saved="saveAiProvider" />
  </div>
</template>
<style scoped>
.ops-shell{min-height:100vh;display:grid;grid-template-columns:236px minmax(0,1fr);background:color-mix(in srgb,var(--qp-pane) 32%,transparent)}
.ops-sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:22px 14px 16px;border-right:1px solid var(--qp-border);background:var(--qp-pane)}
.ops-brand,.ops-account{display:flex;align-items:center;gap:11px}.ops-brand{padding:0 10px 22px}.ops-brand-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;color:#fff;background:linear-gradient(135deg,#6366f1,#8b5cf6);font-weight:800;box-shadow:0 8px 20px rgba(99,102,241,.24)}
.ops-brand div,.ops-account div,.ops-topbar>div{display:flex;flex-direction:column;min-width:0}.ops-brand strong{font-size:17px}.ops-brand small,.ops-account span,.ops-topbar span{color:var(--qp-text-muted);font-size:11px}.ops-nav{display:flex;flex-direction:column;gap:5px}.ops-nav button{width:100%;display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:8px;padding:10px 12px;border:0;border-radius:9px;color:inherit;background:transparent;text-align:left;cursor:pointer;font:inherit}.ops-nav button:hover{background:color-mix(in srgb,#6366f1 9%,transparent)}.ops-nav button.active{color:#6366f1;background:color-mix(in srgb,#6366f1 14%,transparent)}.ops-nav b{font-weight:600}.ops-nav em{padding:1px 7px;border-radius:20px;background:color-mix(in srgb,var(--qp-border) 55%,transparent);font-size:11px;font-style:normal}.ops-account{margin-top:auto;padding:13px 10px 2px;border-top:1px solid var(--qp-border)}.ops-account strong{overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.ops-main{min-width:0}.ops-topbar{height:72px;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:0 30px;border-bottom:1px solid var(--qp-border);background:color-mix(in srgb,var(--qp-pane) 94%,transparent)}.ops-topbar>div strong{font-size:15px}.ops-content{padding:32px clamp(22px,3vw,48px) 64px}.ops-heading{margin-bottom:24px}.ops-heading span{color:#6366f1;font-size:11px;font-weight:700;letter-spacing:.1em}.ops-heading h1{margin:5px 0 7px;font-size:28px}.ops-heading p{margin:0;color:var(--qp-text-muted)}.totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:22px}.row-actions{display:flex;gap:8px}.password-field{width:100%}.password-tip{display:block;margin-top:7px;font-size:12px}
@media(max-width:1000px){.ops-shell{grid-template-columns:76px minmax(0,1fr)}.ops-sidebar{padding-inline:9px}.ops-brand{justify-content:center;padding-inline:10px}.ops-brand div,.ops-nav b,.ops-nav em,.ops-account div{display:none}.ops-nav button{display:flex;justify-content:center;padding:12px}.ops-account{justify-content:center;padding-inline:0}.totals{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:720px){.ops-shell{display:block}.ops-sidebar{position:static;width:auto;height:auto;padding:10px 12px;flex-direction:row;align-items:center}.ops-brand{padding:0}.ops-brand div,.ops-account{display:none}.ops-nav{flex:1;flex-direction:row;justify-content:flex-end}.ops-nav button{width:auto}.ops-topbar{height:auto;padding:12px 16px;align-items:flex-start;flex-direction:column}.ops-content{padding:24px 16px 48px}.totals{grid-template-columns:1fr 1fr}}
</style>
