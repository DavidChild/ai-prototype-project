<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useRoute, useRouter } from 'vue-router'
import { authApi } from '@/services/saas'
import { useAuthStore } from '@/stores/auth'

const route = useRoute(), router = useRouter(), message = useMessage(), auth = useAuthStore()
const token = computed(() => String(route.params.token || ''))
const loading = ref(true), submitting = ref(false), error = ref('')
const invitation = ref<{ tenantName: string; role: 'designer' | 'reviewer'; expiresAt: number } | null>(null)
const captcha = ref<{ id: string; image: string; expiresIn: number } | null>(null)
const form = reactive({ displayName: '', username: '', email: '', password: '', confirmPassword: '', captchaCode: '' })
const roleLabel = computed(() => invitation.value?.role === 'reviewer' ? '审阅者' : '设计员')
const disabled = computed(() => !invitation.value || !form.displayName.trim() || !form.username.trim() || !form.email.trim() || form.password.length < 8 || form.password !== form.confirmPassword || !form.captchaCode.trim())
async function refreshCaptcha() { form.captchaCode = ''; captcha.value = await authApi.captcha('register') }
async function initialize() { loading.value = true; try { invitation.value = await authApi.inviteInfo(token.value); await refreshCaptcha() } catch (cause) { error.value = cause instanceof Error ? cause.message : '邀请链接无效' } finally { loading.value = false } }
async function submit() { if (disabled.value || !captcha.value) return; submitting.value = true; try { await authApi.acceptInvite({ token: token.value, ...form, captchaId: captcha.value.id, captchaCode: form.captchaCode }); await auth.refresh(true); message.success(`已加入“${invitation.value?.tenantName}”团队`); await router.replace('/') } catch (cause) { message.error(cause instanceof Error ? cause.message : '注册失败'); await refreshCaptcha() } finally { submitting.value = false } }
onMounted(initialize)
</script>

<template>
  <div class="invite-page"><n-card class="invite-card" title="个人注册"><n-spin :show="loading"><n-result v-if="error" status="error" title="邀请链接不可用" :description="error"><template #footer><n-button @click="router.push('/login')">返回登录</n-button></template></n-result><template v-else-if="invitation"><n-alert type="info" :bordered="false" class="invite-alert">通过邀请链接仅需注册个人账号。注册完成后将自动加入 <strong>{{ invitation.tenantName }}</strong>，角色为 <strong>{{ roleLabel }}</strong>，不会创建新的企业或工作区。</n-alert><n-form label-placement="top"><n-form-item label="姓名"><n-input v-model:value="form.displayName" /></n-form-item><n-form-item label="登录账号"><n-input v-model:value="form.username" maxlength="48" placeholder="设置用于登录的个人账号" /></n-form-item><n-form-item label="邮箱"><n-input v-model:value="form.email" placeholder="name@company.com" /></n-form-item><n-form-item label="密码"><n-input v-model:value="form.password" type="password" show-password-on="mousedown" placeholder="至少 8 位" /></n-form-item><n-form-item label="确认密码" :validation-status="form.confirmPassword && form.confirmPassword !== form.password ? 'error' : undefined" :feedback="form.confirmPassword && form.confirmPassword !== form.password ? '两次输入的密码不一致' : undefined"><n-input v-model:value="form.confirmPassword" type="password" /></n-form-item><n-form-item label="验证码"><div class="captcha-row"><n-input v-model:value="form.captchaCode" maxlength="4" placeholder="输入图中字符" @keyup.enter="submit" /><button type="button" class="captcha-image" @click="refreshCaptcha"><img v-if="captcha" :src="captcha.image" alt="图片验证码" /></button></div></n-form-item><n-button type="primary" block :disabled="disabled" :loading="submitting" @click="submit">注册个人账号并加入团队</n-button></n-form></template></n-spin></n-card></div>
</template>

<style scoped>
.invite-page { min-height: 100%; display: grid; place-items: center; padding: 32px 16px; background: radial-gradient(circle at 20% 10%, rgba(99,102,241,.18), transparent 34%), var(--qp-canvas-bg); }
.invite-card { width: min(500px, 96vw); box-shadow: 0 24px 80px rgba(0,0,0,.22); }
.invite-alert { margin-bottom: 18px; }
.captcha-row { width: 100%; display: grid; grid-template-columns: minmax(0,1fr) 134px; gap: 12px; }
.captcha-image { height: 34px; padding: 0; border: 1px solid var(--qp-border); border-radius: 6px; background: #f8fafc; overflow: hidden; cursor: pointer; }
.captcha-image img { width: 100%; height: 100%; display: block; }
</style>
