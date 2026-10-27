<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { NButton, NSelect, NSpace, NSwitch, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { saasApi, type TeamMember } from '@/services/saas'
import { useAuthStore } from '@/stores/auth'
import type { TenantRole } from '@/types/saas'
import TenantAdminShell from '@/components/account/TenantAdminShell.vue'

const auth = useAuthStore()
const message = useMessage()
const dialog = useDialog()
const tab = ref('team')
const loading = ref(true)
const members = ref<TeamMember[]>([])
const data = ref<any>({ projects: [], members: [], assigned: [] })
const show = ref(false)
const saving = ref(false)
const inviteShow = ref(false)
const inviteSaving = ref(false)
const inviteResult = ref<{ url: string; expiresAt: number } | null>(null)
const editShow = ref(false)
const editSaving = ref(false)
const editingMember = ref<TeamMember | null>(null)
const editForm = reactive({ displayName: '', username: '', email: '' })
const inviteForm = reactive<{ role: 'designer' | 'reviewer'; expiresHours: number }>({ role: 'designer', expiresHours: 24 })
const form = reactive<{ username: string; email: string; displayName: string; password: string; role: TenantRole }>({ username: '', email: '', displayName: '', password: '', role: 'designer' })
const roleOptions = [{ label: '管理员', value: 'tenant_admin' }, { label: '设计员', value: 'designer' }, { label: '审阅者', value: 'reviewer' }]
const statusOptions = [{ label: '启用', value: 'active' }, { label: '停用', value: 'disabled' }]
const roleLabels: Record<TenantRole, string> = { tenant_admin: '团队管理员', designer: '设计员', reviewer: '审阅者' }
const assignmentMap = computed<Map<string, string[]>>(() => new Map(data.value.projects.map((project: any) => [String(project.familyId), data.value.assigned.filter((item: any) => item.familyId === project.familyId).map((item: any) => String(item.userId))])))
const assignableMembers = computed(() => data.value.members.filter((member: any) => member.role !== 'tenant_admin').map((member: any) => ({ label: `${member.displayName}（${member.username}）· ${member.role === 'designer' ? '设计员' : '审阅者'}`, value: member.id })))

async function refresh() { loading.value = true; try { [members.value, data.value] = await Promise.all([saasApi.team(), saasApi.assignments()]) } finally { loading.value = false } }
async function create() { saving.value = true; try { await saasApi.createMember(form); show.value = false; Object.assign(form, { username: '', email: '', displayName: '', password: '', role: 'designer' }); message.success('成员已创建'); await refresh() } catch (error) { message.error(error instanceof Error ? error.message : '创建失败') } finally { saving.value = false } }
async function update(member: TeamMember, role: TenantRole, status = member.status, permissions?: { canCreateProject: boolean; canCreateIteration: boolean }) {
  const next = permissions ?? { canCreateProject: member.canCreateProject, canCreateIteration: member.canCreateIteration }
  try {
    await saasApi.updateMember({ userId: member.id, role, status, ...next })
    message.success('成员权限已更新')
    await refresh()
  } catch (error) { message.error(error instanceof Error ? error.message : '更新失败') }
}
async function assign(familyId: string, userIds: string[]) { try { await saasApi.updateAssignments(familyId, userIds); message.success('项目全部迭代版本的授权已保存'); await refresh() } catch (error) { message.error(error instanceof Error ? error.message : '保存失败') } }
function openInvite() { inviteResult.value = null; inviteShow.value = true }
async function createInvite() { inviteSaving.value = true; try { const result = await saasApi.createInvite(inviteForm.role, inviteForm.expiresHours); inviteResult.value = { url: `${window.location.origin}${result.path}`, expiresAt: result.expiresAt } } catch (error) { message.error(error instanceof Error ? error.message : '邀请链接生成失败') } finally { inviteSaving.value = false } }
async function copyInvite() { if (!inviteResult.value) return; await navigator.clipboard.writeText(inviteResult.value.url); message.success('邀请链接已复制') }
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
function generatePassword() {
  form.password = createRandomPassword()
  message.success('已生成 12 位初始密码')
}
async function copyInitialPassword() {
  if (!form.password) return
  await navigator.clipboard.writeText(form.password)
  message.success('初始密码已复制')
}
function openEditMember(member: TeamMember) {
  editingMember.value = member
  Object.assign(editForm, { displayName: member.displayName, username: member.username, email: member.email })
  editShow.value = true
}
async function saveMemberProfile() {
  if (!editingMember.value || editSaving.value) return
  editSaving.value = true
  try {
    await saasApi.updateMemberProfile({ userId: editingMember.value.id, ...editForm })
    editShow.value = false
    message.success('成员账号信息已更新')
    await refresh()
    if (editingMember.value.id === auth.user?.userId) await auth.refresh(true)
  } catch (error) { message.error(error instanceof Error ? error.message : '成员账号信息更新失败') } finally { editSaving.value = false }
}
function copyMemberInfo(member: TeamMember) {
  dialog.warning({
    title: '重置密码并复制账号信息',
    content: '系统无法读取成员原密码。继续后将为“' + member.displayName + '”生成新的临时密码，原密码立即失效，并自动复制完整登录信息。',
    positiveText: '重置并复制',
    negativeText: '取消',
    async onPositiveClick() {
      const password = createRandomPassword()
      await saasApi.resetMemberPassword(member.id, password)
      const accountInfo = [
        '组织：' + (auth.user?.tenantName || '个人工作区'),
        '姓名：' + member.displayName,
        '角色：' + roleLabels[member.role],
        '登录账号：' + member.username,
        '邮箱：' + member.email,
        '临时密码：' + password,
        '提示：请首次登录后妥善保管并及时修改密码。',
      ].join('\n')
      await navigator.clipboard.writeText(accountInfo)
      message.success('密码已重置，账号信息已复制')
    },
  })
}
const memberColumns: DataTableColumns<TeamMember> = [
  { title: '姓名', key: 'displayName' },
  { title: '登录账号', key: 'username' },
  { title: '邮箱', key: 'email' },
  { title: '角色', key: 'role', width: 150, render: (row) => h(NSelect, { value: row.role, options: roleOptions, size: 'small', onUpdateValue: (value: TenantRole) => update(row, value) }) },
  {
    title: '创建权限', key: 'createPermissions', width: 210,
    render: (row) => {
      if (row.role === 'reviewer') return h(NTag, { size: 'small', bordered: false }, { default: () => '不可创建' })
      const disabled = row.role === 'tenant_admin'
      return h(NSpace, { vertical: true, size: 6 }, { default: () => [
        h(NSpace, { align: 'center', size: 8 }, { default: () => [
          h(NSwitch, { size: 'small', value: row.canCreateProject, disabled, onUpdateValue: (value: boolean) => update(row, row.role, row.status, { canCreateProject: value, canCreateIteration: row.canCreateIteration }) }),
          h('span', '创建项目'),
        ] }),
        h(NSpace, { align: 'center', size: 8 }, { default: () => [
          h(NSwitch, { size: 'small', value: row.canCreateIteration, disabled, onUpdateValue: (value: boolean) => update(row, row.role, row.status, { canCreateProject: row.canCreateProject, canCreateIteration: value }) }),
          h('span', '创建项目版本'),
        ] }),
      ] })
    },
  },
  { title: '项目数', key: 'projectCount', width: 80 },
  {
    title: '状态', key: 'status', width: 120,
    render: (row) => h(NSelect, {
      value: row.status,
      options: statusOptions,
      size: 'small',
      disabled: row.id === auth.user?.userId,
      onUpdateValue: (value: string) => update(row, row.role, value),
    }),
  },
  {
    title: '账号信息', key: 'actions', width: 290,
    render: (row) => h(NSpace, { size: 8, wrap: false }, {
      default: () => [
        h(NTag, { size: 'small', type: row.status === 'active' ? 'success' : 'default', bordered: false }, { default: () => row.status === 'active' ? '可登录' : '已停用' }),
        h(NButton, { size: 'small', secondary: true, onClick: () => openEditMember(row) }, { default: () => '编辑资料' }),
        h(NButton, { size: 'small', type: 'primary', secondary: true, onClick: () => copyMemberInfo(row) }, { default: () => '重置并复制' }),
      ],
    }),
  },
]
onMounted(refresh)
</script>

<template>
  <TenantAdminShell active="team" title="团队管理" description="管理团队成员、项目授权与 AI Token 使用情况。">
    <template #actions><n-button @click="openInvite">邀请成员</n-button><n-button type="primary" @click="show = true">新增成员</n-button></template>
    <div class="admin-page">
    <n-spin :show="loading">
      <n-tabs v-model:value="tab" type="segment">
        <n-tab-pane name="team" tab="员工与权限"><n-data-table :columns="memberColumns" :data="members" :scroll-x="1320" /></n-tab-pane>
        <n-tab-pane name="projects" tab="项目授权">
          <n-alert type="info" :bordered="false" style="margin-bottom:14px">项目授权不区分迭代版本，保存后自动应用到该项目现有的全部版本。</n-alert>
          <n-empty v-if="!data.projects.length" description="暂无可授权项目" />
          <n-card v-for="project in data.projects" :key="project.familyId" size="small" style="margin-bottom:12px">
            <template #header><n-space align="center"><strong>{{ project.name }}</strong><n-tag size="small" :bordered="false">{{ project.iterationCount }} 个迭代版本</n-tag></n-space></template>
            <n-select multiple filterable :value="assignmentMap.get(project.familyId) || []" :options="assignableMembers" placeholder="选择可访问该项目全部版本的设计员和审阅者" @update:value="(ids: string[]) => assign(project.familyId, ids)" />
          </n-card>
        </n-tab-pane>
      </n-tabs>
    </n-spin>
    <n-modal v-model:show="show" preset="card" title="新增团队成员" style="width:460px"><n-form label-placement="top"><n-form-item label="姓名"><n-input v-model:value="form.displayName" /></n-form-item><n-form-item label="登录账号"><n-input v-model:value="form.username" maxlength="48" placeholder="字母、数字、点、下划线或短横线" /></n-form-item><n-form-item label="邮箱"><n-input v-model:value="form.email" /></n-form-item><n-form-item label="初始密码"><div class="password-field"><n-input-group><n-input v-model:value="form.password" type="password" show-password-on="click" placeholder="至少 8 位，可手动输入或自动生成" /><n-button @click="generatePassword">自动生成</n-button><n-button :disabled="!form.password" @click="copyInitialPassword">复制</n-button></n-input-group><n-text depth="3" class="password-tip">自动生成的密码包含大小写字母、数字和特殊字符。</n-text></div></n-form-item><n-form-item label="角色"><n-select v-model:value="form.role" :options="roleOptions" /></n-form-item></n-form><template #footer><n-space justify="end"><n-button @click="show = false">取消</n-button><n-button type="primary" :loading="saving" :disabled="!form.displayName.trim() || !form.username.trim() || !form.email.trim() || form.password.length < 8" @click="create">创建</n-button></n-space></template></n-modal>
    <n-modal v-model:show="editShow" preset="card" title="编辑成员账号信息" style="width:460px"><n-form label-placement="top"><n-form-item label="姓名"><n-input v-model:value="editForm.displayName" maxlength="50" /></n-form-item><n-form-item label="登录账号"><n-input v-model:value="editForm.username" maxlength="48" /></n-form-item><n-form-item label="邮箱"><n-input v-model:value="editForm.email" /></n-form-item></n-form><template #footer><n-space justify="end"><n-button @click="editShow = false">取消</n-button><n-button type="primary" :loading="editSaving" :disabled="!editForm.displayName.trim() || !editForm.username.trim() || !editForm.email.trim()" @click="saveMemberProfile">保存</n-button></n-space></template></n-modal>
    <n-modal v-model:show="inviteShow" preset="card" title="邀请团队成员" style="width:500px">
      <template v-if="!inviteResult">
        <n-alert type="info" :bordered="false" style="margin-bottom:16px">生成临时邀请链接，被邀请人注册成功后会自动加入当前团队。</n-alert>
        <n-form label-placement="top"><n-form-item label="加入角色"><n-radio-group v-model:value="inviteForm.role"><n-radio-button value="designer">设计员</n-radio-button><n-radio-button value="reviewer">审阅者</n-radio-button></n-radio-group></n-form-item><n-form-item label="链接有效期"><n-select v-model:value="inviteForm.expiresHours" :options="[{label:'1 小时',value:1},{label:'24 小时',value:24},{label:'3 天',value:72},{label:'7 天',value:168}]" /></n-form-item></n-form>
      </template>
      <n-result v-else status="success" title="邀请链接已生成" :description="`有效期至 ${new Date(inviteResult.expiresAt).toLocaleString()}`">
        <template #footer><n-input-group><n-input :value="inviteResult.url" readonly /><n-button type="primary" @click="copyInvite">复制链接</n-button></n-input-group><n-text depth="3" style="display:block;margin-top:12px">链接仅可成功注册一次，请单独发送给受邀成员。</n-text></template>
      </n-result>
      <template #footer>
        <n-space v-if="!inviteResult" justify="end"><n-button @click="inviteShow = false">取消</n-button><n-button type="primary" :loading="inviteSaving" @click="createInvite">生成邀请链接</n-button></n-space>
        <n-space v-else justify="end"><n-button @click="inviteShow = false">完成</n-button></n-space>
      </template>
    </n-modal>
    </div>
  </TenantAdminShell>
</template>

<style scoped>
.admin-page { min-width: 0; }
.password-field { width: 100%; }
.password-tip { display: block; margin-top: 7px; font-size: 12px; }
</style>
