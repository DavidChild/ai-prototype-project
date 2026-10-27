<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useRouter } from 'vue-router'
import { authApi } from '@/services/saas'
import { useAuthStore } from '@/stores/auth'
const auth=useAuthStore(), router=useRouter(), message=useMessage(), dialog=useDialog(), submitting=ref(false)
const mode=ref<'login'|'register'>('login')
const registrationType=ref<'enterprise'|'personal'>('enterprise')
const form=reactive({identifier:'',username:'',email:'',password:'',confirmPassword:'',displayName:'',tenantName:'默认工作区',captchaCode:''})
const captcha=ref<{id:string;image:string;expiresIn:number}|null>(null), captchaLoading=ref(false)
const firstRun=computed(()=>!!auth.status?.setupRequired)
const registering=computed(()=>!firstRun.value&&mode.value==='register')
const captchaPurpose=computed<'setup'|'login'|'register'>(()=>firstRun.value?'setup':registering.value?'register':'login')
const disabled=computed(()=>!(firstRun.value||registering.value?form.email.trim()&&form.username.trim():form.identifier.trim())||form.password.length<8||!captcha.value||!form.captchaCode.trim()||((firstRun.value||registering.value)&&!form.displayName.trim())||(firstRun.value&&!form.tenantName.trim())||(registering.value&&registrationType.value==='enterprise'&&!form.tenantName.trim())||(registering.value&&form.password!==form.confirmPassword))
async function refreshCaptcha(){captchaLoading.value=true;form.captchaCode='';try{captcha.value=await authApi.captcha(captchaPurpose.value)}catch(error){captcha.value=null;message.error(error instanceof Error?error.message:'验证码加载失败')}finally{captchaLoading.value=false}}
watch(mode,()=>{form.password='';form.confirmPassword='';if(mode.value==='register'&&form.tenantName==='默认工作区')form.tenantName='';void refreshCaptcha()})
watch(firstRun,()=>void refreshCaptcha())
function registrationWorkspaceName(){return registrationType.value==='personal'?`${form.displayName.trim()}的个人工作区`:form.tenantName.trim()}
function confirmRegistrationSuccess(){return new Promise<void>((resolve)=>{const personal=registrationType.value==='personal';dialog.success({title:personal?'个人账号注册成功':'企业账号注册成功',content:personal?'个人工作区已创建，您可以直接开始创建和管理原型项目。':`“${form.tenantName.trim()}”工作区已创建，当前账号已成为企业管理员。您可以进入系统创建员工并分配项目权限。`,positiveText:'进入工作区',closable:false,maskClosable:false,onPositiveClick:()=>resolve()})})}
async function submit(){ if(submitting.value||disabled.value||!captcha.value)return; submitting.value=true; try{const isRegistration=registering.value;const verification={captchaId:captcha.value.id,captchaCode:form.captchaCode};let destination='/';if(firstRun.value)destination=((await authApi.setup({...form,...verification})) as {destination?:string}).destination??'/ops';else if(isRegistration)await authApi.register({...form,tenantName:registrationWorkspaceName(),accountType:registrationType.value,...verification});else destination=(await authApi.login(form.identifier,form.password,verification.captchaId,verification.captchaCode)).destination;await auth.refresh(true);if(auth.isOperator)destination='/ops';if(isRegistration)await confirmRegistrationSuccess();else message.success(auth.isOperator?'已识别为平台运营管理者，正在进入运营端':'登录成功');await router.replace(destination)}catch(error){message.error(error instanceof Error?error.message:(registering.value?'注册失败':'登录失败'));await refreshCaptcha()}finally{submitting.value=false} }
onMounted(refreshCaptcha)
</script>
<template>
  <div class="login-page">
    <n-card class="login-card" :title="firstRun ? '设置平台运营管理者账号' : registering ? '企业 / 个人注册' : '登录 小豆原型'">
      <n-alert v-if="firstRun" type="info" :bordered="false" class="form-alert">这是平台特殊运营账号，用于管理入驻企业，并查看全平台项目、版本、修改次数及 Token 消耗。创建后同时接管默认工作区和现有 MySQL 项目。</n-alert>
      <n-tabs v-else v-model:value="mode" type="segment" class="mode-tabs"><n-tab name="login">账号登录</n-tab><n-tab name="register">企业 / 个人注册</n-tab></n-tabs>
      <n-alert v-if="registering" type="success" :bordered="false" class="form-alert">选择企业使用可创建团队并管理员工权限；选择个人使用可直接创建个人工作区。</n-alert>
      <n-form label-placement="top">
        <n-form-item v-if="registering" label="注册类型"><n-radio-group v-model:value="registrationType"><n-radio-button value="enterprise">企业使用</n-radio-button><n-radio-button value="personal">个人使用</n-radio-button></n-radio-group></n-form-item>
        <n-form-item v-if="firstRun || (registering && registrationType === 'enterprise')" :label="firstRun ? '默认工作区名称' : '企业名称'"><n-input v-model:value="form.tenantName" maxlength="100" placeholder="请输入企业或团队名称" /></n-form-item>
        <n-form-item v-if="firstRun || registering" :label="firstRun ? '运营管理者姓名' : registrationType === 'personal' ? '姓名' : '管理员姓名'"><n-input v-model:value="form.displayName" maxlength="50" :placeholder="firstRun ? '请输入运营管理者姓名' : '请输入姓名'" /></n-form-item>
        <n-form-item v-if="firstRun || registering" label="登录账号"><n-input v-model:value="form.username" maxlength="48" autocomplete="username" placeholder="设置用于登录的账号" /></n-form-item>
        <n-form-item v-if="firstRun || registering" label="邮箱"><n-input v-model:value="form.email" autocomplete="email" placeholder="name@company.com" /></n-form-item>
        <n-form-item v-else label="账号或邮箱"><n-input v-model:value="form.identifier" autocomplete="username" placeholder="请输入登录账号或邮箱" /></n-form-item>
        <n-form-item label="密码"><n-input v-model:value="form.password" type="password" show-password-on="mousedown" :autocomplete="registering ? 'new-password' : 'current-password'" placeholder="至少 8 位" @keyup.enter="!registering && submit()" /></n-form-item>
        <n-form-item v-if="registering" label="确认密码" :validation-status="form.confirmPassword && form.confirmPassword !== form.password ? 'error' : undefined" :feedback="form.confirmPassword && form.confirmPassword !== form.password ? '两次输入的密码不一致' : undefined"><n-input v-model:value="form.confirmPassword" type="password" show-password-on="mousedown" autocomplete="new-password" /></n-form-item>
        <n-form-item label="验证码"><div class="captcha-block"><div class="captcha-row"><n-input v-model:value="form.captchaCode" maxlength="4" placeholder="输入图中字符" @keyup.enter="submit" /><button type="button" class="captcha-image" :disabled="captchaLoading" title="点击刷新验证码" @click="refreshCaptcha"><n-spin v-if="captchaLoading" size="small" /><img v-else-if="captcha" :src="captcha.image" alt="图片验证码" /><span v-else>重新加载</span></button></div><n-text depth="3" class="captcha-hint">验证码 5 分钟有效，点击图片可刷新，不区分大小写。</n-text></div></n-form-item>
        <n-button class="submit-button" type="primary" block :loading="submitting" :disabled="disabled" @click="submit">{{ firstRun ? '创建运营管理者并进入' : registering ? (registrationType === 'personal' ? '注册个人账号' : '注册企业账号') : '登录' }}</n-button>
      </n-form>
    </n-card>
  </div>
</template>
<style scoped>.login-page{min-height:100%;display:grid;place-items:center;padding:36px 24px;background:radial-gradient(circle at 20% 10%,rgba(99,102,241,.18),transparent 34%),var(--qp-canvas-bg);overflow:auto}.login-card{width:min(520px,94vw);box-shadow:0 24px 80px rgba(0,0,0,.22)}.mode-tabs,.form-alert{margin-bottom:20px}.captcha-block{width:100%;min-width:0}.captcha-row{width:100%;display:grid;grid-template-columns:minmax(180px,1fr) 134px;gap:12px;align-items:stretch}.captcha-image{height:34px;padding:0;border:1px solid var(--qp-border);border-radius:6px;background:#f8fafc;overflow:hidden;cursor:pointer;display:grid;place-items:center;color:#475569}.captcha-image:disabled{cursor:wait;opacity:.75}.captcha-image img{width:100%;height:100%;display:block;object-fit:fill}.captcha-hint{display:block;margin-top:8px;font-size:12px;line-height:1.5}.submit-button{margin-top:4px}@media(max-width:520px){.login-page{padding:20px 12px}.captcha-row{grid-template-columns:1fr}.captcha-image{width:134px}.login-card{width:100%}}</style>

