import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
    { path: '/invite/:token', name: 'team-invite', component: () => import('@/views/InviteRegisterView.vue'), meta: { public: true } },
    { path: '/s/:code', name: 'share-preview', component: () => import('@/views/SharePreviewView.vue'), meta: { share: true } },
    {
      path: '/',
      name: 'projects',
      component: () => import('@/views/ProjectListView.vue'),
    },
    {
      path: '/project/new',
      name: 'project-create',
      component: () => import('@/views/ProjectCreateView.vue'),
    },
    {
      path: '/project/:id',
      name: 'workbench',
      component: () => import('@/views/WorkbenchView.vue'),
    },
    { path: '/iterations', name: 'iteration-tasks', component: () => import('@/views/IterationTasksView.vue'), meta: { iterationCreator: true } },
    { path: '/iterations/:id', name: 'iteration-task-workbench', component: () => import('@/views/IterationTaskWorkbenchView.vue'), meta: { iterationCreator: true } },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { tenantAdmin: true },
    },
    { path: '/settings/providers', name: 'settings-providers', component: () => import('@/views/SettingsView.vue'), meta: { tenantAdmin: true } },
    { path: '/settings/models', name: 'settings-models', component: () => import('@/views/SettingsView.vue'), meta: { tenantAdmin: true } },
    { path: '/settings/parameters', name: 'settings-parameters', component: () => import('@/views/SettingsView.vue'), meta: { tenantAdmin: true } },
    { path: '/saas', name: 'saas-admin', component: () => import('@/views/TenantAdminView.vue'), meta: { tenantAdmin: true } },
    { path: '/usage', name: 'tenant-usage', component: () => import('@/views/TenantUsageView.vue'), meta: { tenantAdmin: true } },
    { path: '/ops', name: 'ops', component: () => import('@/views/OpsView.vue'), meta: { operator: true } },
  ],
})
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  const status = await auth.refresh()
  if (to.meta.share) return true
  if (to.meta.public) return status.authenticated ? (status.user?.platformRole === 'platform_operator' ? '/ops' : '/') : true
  if (!status.authenticated) return { path: '/login', query: { redirect: to.fullPath } }
  if (status.user?.tenantId) await useSettingsStore().loadTenantConfig(false, status.user.tenantId)
  if (to.meta.tenantAdmin && status.user?.tenantRole !== 'tenant_admin') return '/'
  if (to.meta.operator && status.user?.platformRole !== 'platform_operator') return '/'
  if (to.name === 'project-create' && status.user?.tenantRole !== 'tenant_admin' && !status.user?.canCreateProject) return '/'
  if (to.meta.iterationCreator && status.user?.tenantRole !== 'tenant_admin' && !status.user?.canCreateIteration) return '/'
  return true
})

export default router
