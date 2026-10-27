import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { authApi } from '@/services/saas'
import type { AuthStatus } from '@/types/saas'

export const useAuthStore = defineStore('auth', () => {
  const status = ref<AuthStatus | null>(null)
  const loading = ref(false)
  let pending: Promise<AuthStatus> | null = null
  const user = computed(() => status.value?.user ?? null)
  const isAdmin = computed(() => user.value?.tenantRole === 'tenant_admin')
  const isReviewer = computed(() => user.value?.tenantRole === 'reviewer')
  const isOperator = computed(() => user.value?.platformRole === 'platform_operator')
  const canEdit = computed(() => user.value?.tenantRole === 'tenant_admin' || user.value?.tenantRole === 'designer')
  const canCreateProject = computed(() => isAdmin.value || (user.value?.tenantRole === 'designer' && user.value?.canCreateProject === true))
  const canCreateIteration = computed(() => isAdmin.value || (user.value?.tenantRole === 'designer' && user.value?.canCreateIteration === true))
  async function refresh(force = false) {
    if (pending && !force) return pending
    loading.value = true
    pending = authApi.status().then((value) => { status.value = value; return value }).finally(() => { loading.value = false; pending = null })
    return pending
  }
  async function logout() { await authApi.logout(); status.value = { setupRequired: false, authenticated: false, user: null } }
  return { status, loading, user, isAdmin, isReviewer, isOperator, canEdit, canCreateProject, canCreateIteration, refresh, logout }
})

