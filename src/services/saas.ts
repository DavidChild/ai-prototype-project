import { storageRequest } from '@/services/storage/db'
import type { AuthStatus, TenantRole } from '@/types/saas'
import type { ModelSelection, ProviderConfig } from '@/types/provider'

export const authApi = {
  status: () => storageRequest<AuthStatus>('auth.status'),
  captcha: (purpose: 'setup' | 'login' | 'register') => storageRequest<{ id: string; image: string; expiresIn: number }>('auth.captcha', { purpose }),
  login: (identifier: string, password: string, captchaId: string, captchaCode: string) => storageRequest<{ ok: true; destination: string }>('auth.login', { identifier, password, captchaId, captchaCode }),
  register: (input: { tenantName: string; accountType: 'enterprise' | 'personal'; username: string; displayName: string; email: string; password: string; captchaId: string; captchaCode: string }) => storageRequest('auth.register', input),
  inviteInfo: (token: string) => storageRequest<{ tenantName: string; role: 'designer' | 'reviewer'; expiresAt: number }>('auth.invite.info', { token }),
  acceptInvite: (input: { token: string; username: string; displayName: string; email: string; password: string; captchaId: string; captchaCode: string }) => storageRequest<{ ok: true; destination: string }>('auth.invite.accept', input),
  setup: (input: { username: string; email: string; password: string; displayName: string; tenantName: string; captchaId: string; captchaCode: string }) => storageRequest<{ ok: true; destination: string }>('auth.setup', input),
  updateProfile: (input: { username: string; email: string; displayName: string; currentPassword?: string; newPassword?: string }) => storageRequest('auth.profile.update', input),
  logout: () => storageRequest('auth.logout'),
}
export interface TeamMember { id: string; username: string; email: string; displayName: string; status: string; lastLoginAt?: number; role: TenantRole; projectCount: number; canCreateProject: boolean; canCreateIteration: boolean }
export const saasApi = {
  team: () => storageRequest<TeamMember[]>('saas.team.list'),
  createMember: (input: { username: string; email: string; displayName: string; password: string; role: TenantRole }) => storageRequest('saas.team.create', input),
  createInvite: (role: 'designer' | 'reviewer', expiresHours: number) => storageRequest<{ token: string; path: string; role: string; expiresAt: number; tenantName: string }>('saas.invite.create', { role, expiresHours }),
  updateMember: (input: { userId: string; role: TenantRole; status: string; canCreateProject: boolean; canCreateIteration: boolean }) => storageRequest('saas.team.update', input),
  updateMemberProfile: (input: { userId: string; username: string; email: string; displayName: string }) => storageRequest('saas.team.profile.update', input),
  resetMemberPassword: (userId: string, password: string) => storageRequest('saas.team.resetPassword', { userId, password }),
  assignments: () => storageRequest<{ projects: Array<Record<string, any>>; members: TeamMember[]; assigned: { familyId: string; userId: string }[] }>('saas.assignments.list'),
  updateAssignments: (familyId: string, userIds: string[]) => storageRequest('saas.assignments.update', { familyId, userIds }),
  usage: () => storageRequest<any>('saas.usage.summary'),
  aiConfig: () => storageRequest<{ providers: ProviderConfig[]; modelSelection: ModelSelection; allowedModels: string[]; allowedPresetModels: Record<string, string[]> }>('ai.config.get'),
  saveAiProvider: (provider: ProviderConfig) => storageRequest('ai.tenant.provider.upsert', { provider }),
  removeAiProvider: (providerId: string) => storageRequest('ai.tenant.provider.remove', { providerId }),
  saveAiSelection: (modelSelection: ModelSelection) => storageRequest('ai.tenant.selection.update', { modelSelection }),
}
export const opsApi = {
  summary: () => storageRequest<any>('ops.summary'),
  tenantDetail: (tenantId: string) => storageRequest<any>('ops.tenant.detail', { tenantId }),
  createTenant: (input: { name: string; username: string; email: string; displayName: string; password: string }) => storageRequest('ops.tenant.create', input),
  updateTenant: (tenantId: string, name: string, status: string) => storageRequest('ops.tenant.update', { tenantId, name, status }),
  resetTenantAdminPassword: (tenantId: string, userId: string, password: string) => storageRequest('ops.tenant.resetAdminPassword', { tenantId, userId, password }),
  tenantAdminCredential: (tenantId: string, userId: string) => storageRequest<{ password: string }>('ops.tenant.adminCredential', { tenantId, userId }),
  aiProviders: () => storageRequest<ProviderConfig[]>('ops.ai.providers.list'),
  saveAiProvider: (provider: ProviderConfig) => storageRequest('ops.ai.providers.upsert', { provider }),
  removeAiProvider: (providerId: string) => storageRequest('ops.ai.providers.remove', { providerId }),
  allowedAiModels: () => storageRequest<{ pool: Array<{ id: string; providerPresetId: string; providerName: string; protocol: string; model: string }>; selectedIds: string[]; allModelsEnabled: boolean }>('ops.ai.models.list'),
  saveAllowedAiModels: (modelIds: string[], allModelsEnabled: boolean) => storageRequest('ops.ai.models.update', { modelIds, allModelsEnabled }),
}

