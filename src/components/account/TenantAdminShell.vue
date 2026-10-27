<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import AccountSettingsDialog from '@/components/account/AccountSettingsDialog.vue'

defineProps<{
  active: 'projects' | 'team' | 'usage' | 'settings'
  title: string
  description: string
}>()

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const settings = useSettingsStore()
const accountSettingsShow = ref(false)
const userInitial = computed(() => (auth.user?.displayName || auth.user?.email || 'U').trim().slice(0, 1).toUpperCase())

async function logout() {
  await auth.logout()
  await router.push('/login')
}
</script>

<template>
  <div class="tenant-shell">
    <aside class="tenant-sidebar">
      <div class="tenant-brand">
        <span class="brand-mark">豆</span>
        <div><strong>小豆原型</strong><small>团队设计空间</small></div>
      </div>
      <nav class="tenant-nav" aria-label="租户后台导航">
        <button :class="{ active: active === 'projects' }" @click="router.push('/')"><span>▦</span><b>项目工作台</b></button>
        <button :class="{ active: active === 'team' }" @click="router.push('/saas')"><span>♙</span><b>团队管理</b></button>
        <button :class="{ active: active === 'usage' }" @click="router.push('/usage')"><span>◫</span><b>用量使用情况</b></button>
        <button :class="{ active: active === 'settings' }" @click="router.push('/settings/providers')"><span>⚙</span><b>模型设置</b></button>
        <div v-if="active === 'settings'" class="tenant-subnav" aria-label="模型设置子菜单">
          <button :class="{ active: route.path === '/settings/providers' || route.path === '/settings' }" @click="router.push('/settings/providers')">服务商</button>
          <button :class="{ active: route.path === '/settings/models' }" @click="router.push('/settings/models')">默认模型</button>
          <button :class="{ active: route.path === '/settings/parameters' }" @click="router.push('/settings/parameters')">生成参数</button>
        </div>
      </nav>
      <div class="tenant-account">
        <n-avatar round size="medium">{{ userInitial }}</n-avatar>
        <div><strong>{{ auth.user?.tenantName || '个人工作区' }}</strong><span>{{ auth.user?.displayName }} · 管理员</span></div>
      </div>
    </aside>
    <main class="tenant-main">
      <header class="tenant-topbar">
        <div><strong>{{ title }}</strong><span>{{ description }}</span></div>
        <n-space>
          <slot name="actions" />
          <n-button secondary @click="accountSettingsShow = true">账号设置</n-button>
          <n-button secondary :title="settings.appTheme === 'dark' ? '切换到浅色' : '切换到深色'" @click="settings.toggleAppTheme()">{{ settings.appTheme === 'dark' ? '🌙' : '☀️' }}</n-button>
          <n-button quaternary @click="logout">退出登录</n-button>
        </n-space>
      </header>
      <section class="tenant-content">
        <div class="tenant-heading"><span>TEAM WORKSPACE</span><h1>{{ title }}</h1><p>{{ description }}</p></div>
        <slot />
      </section>
    </main>
    <AccountSettingsDialog v-model:show="accountSettingsShow" />
  </div>
</template>

<style scoped>
.tenant-shell{min-height:100vh;display:grid;grid-template-columns:236px minmax(0,1fr);background:color-mix(in srgb,var(--qp-pane) 32%,transparent)}
.tenant-sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:22px 14px 16px;border-right:1px solid var(--qp-border);background:var(--qp-pane)}
.tenant-brand,.tenant-account{display:flex;align-items:center;gap:11px}.tenant-brand{padding:0 10px 22px}.brand-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;color:#fff;background:linear-gradient(135deg,#6366f1,#8b5cf6);font-weight:800;box-shadow:0 8px 20px rgba(99,102,241,.24)}
.tenant-brand div,.tenant-account div,.tenant-topbar>div{display:flex;flex-direction:column;min-width:0}.tenant-brand strong{font-size:17px}.tenant-brand small,.tenant-account span,.tenant-topbar span{color:var(--qp-text-muted);font-size:11px}.tenant-nav{display:flex;flex-direction:column;gap:5px}.tenant-nav button{width:100%;display:grid;grid-template-columns:24px 1fr;align-items:center;gap:8px;padding:10px 12px;border:0;border-radius:9px;color:inherit;background:transparent;text-align:left;cursor:pointer;font:inherit}.tenant-nav button:hover{background:color-mix(in srgb,#6366f1 9%,transparent)}.tenant-nav button.active{color:#6366f1;background:color-mix(in srgb,#6366f1 14%,transparent)}.tenant-nav b{font-weight:600}.tenant-subnav{display:flex;flex-direction:column;gap:3px;margin:-1px 0 5px 32px;padding-left:10px;border-left:1px solid var(--qp-border)}.tenant-subnav button{display:block;padding:7px 10px;color:var(--qp-text-muted);font-size:12px}.tenant-subnav button.active{color:#6366f1;background:color-mix(in srgb,#6366f1 10%,transparent)}.tenant-account{margin-top:auto;padding:13px 10px 2px;border-top:1px solid var(--qp-border)}.tenant-account strong{overflow:hidden;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.tenant-main{min-width:0}.tenant-topbar{height:72px;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:0 30px;border-bottom:1px solid var(--qp-border);background:color-mix(in srgb,var(--qp-pane) 94%,transparent)}.tenant-topbar>div strong{font-size:15px}.tenant-content{padding:32px clamp(22px,3vw,48px) 64px}.tenant-heading{margin-bottom:24px}.tenant-heading span{color:#6366f1;font-size:11px;font-weight:700;letter-spacing:.1em}.tenant-heading h1{margin:5px 0 7px;font-size:28px}.tenant-heading p{margin:0;color:var(--qp-text-muted)}
@media(max-width:900px){.tenant-shell{grid-template-columns:76px minmax(0,1fr)}.tenant-sidebar{padding-inline:9px}.tenant-brand{justify-content:center;padding-inline:10px}.tenant-brand div,.tenant-nav b,.tenant-account div,.tenant-subnav{display:none}.tenant-nav button{display:flex;justify-content:center;padding:12px}.tenant-account{justify-content:center;padding-inline:0}}
@media(max-width:720px){.tenant-shell{display:block}.tenant-sidebar{position:static;width:auto;height:auto;padding:10px 12px;flex-direction:row;align-items:center}.tenant-brand{padding:0}.tenant-brand div,.tenant-account{display:none}.tenant-nav{flex:1;flex-direction:row;justify-content:flex-end}.tenant-nav button{width:auto}.tenant-topbar{height:auto;padding:12px 16px;align-items:flex-start;flex-direction:column}.tenant-content{padding:24px 16px 48px}}
</style>
