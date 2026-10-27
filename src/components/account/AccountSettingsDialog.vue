<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { authApi } from '@/services/saas'
import { useAuthStore } from '@/stores/auth'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [value: boolean] }>()
const auth = useAuthStore(), message = useMessage(), saving = ref(false)
const form = reactive({ displayName: '', username: '', email: '', currentPassword: '', newPassword: '', confirmPassword: '' })
const passwordMismatch = computed(() => !!form.newPassword && form.newPassword !== form.confirmPassword)
const disabled = computed(() => !form.displayName.trim() || !form.username.trim() || !form.email.trim() || passwordMismatch.value || (!!form.newPassword && (form.newPassword.length < 8 || !form.currentPassword)))

watch(() => props.show, (show) => {
  if (!show) return
  Object.assign(form, { displayName: auth.user?.displayName || '', username: auth.user?.username || '', email: auth.user?.email || '', currentPassword: '', newPassword: '', confirmPassword: '' })
}, { immediate: true })

async function save() {
  if (disabled.value || saving.value) return
  saving.value = true
  try {
    await authApi.updateProfile({ displayName: form.displayName, username: form.username, email: form.email, currentPassword: form.currentPassword || undefined, newPassword: form.newPassword || undefined })
    await auth.refresh(true)
    emit('update:show', false)
    message.success(form.newPassword ? '账号信息和密码已更新' : '账号信息已更新')
  } catch (error) { message.error(error instanceof Error ? error.message : '账号信息更新失败') } finally { saving.value = false }
}
</script>

<template>
  <n-modal :show="show" preset="card" title="账号设置" style="width:500px" @update:show="emit('update:show', $event)">
    <n-form label-placement="top">
      <n-form-item label="姓名"><n-input v-model:value="form.displayName" maxlength="50" /></n-form-item>
      <n-form-item label="登录账号"><n-input v-model:value="form.username" maxlength="48" placeholder="3-48 位字母、数字、点、下划线或短横线" /></n-form-item>
      <n-form-item label="邮箱"><n-input v-model:value="form.email" /></n-form-item>
      <n-divider>修改密码（可选）</n-divider>
      <n-form-item label="当前密码"><n-input v-model:value="form.currentPassword" type="password" show-password-on="click" autocomplete="current-password" /></n-form-item>
      <n-form-item label="新密码"><n-input v-model:value="form.newPassword" type="password" show-password-on="click" autocomplete="new-password" placeholder="不修改请留空，至少 8 位" /></n-form-item>
      <n-form-item label="确认新密码" :validation-status="passwordMismatch ? 'error' : undefined" :feedback="passwordMismatch ? '两次输入的新密码不一致' : undefined"><n-input v-model:value="form.confirmPassword" type="password" autocomplete="new-password" /></n-form-item>
    </n-form>
    <template #footer><n-space justify="end"><n-button @click="emit('update:show', false)">取消</n-button><n-button type="primary" :disabled="disabled" :loading="saving" @click="save">保存</n-button></n-space></template>
  </n-modal>
</template>
