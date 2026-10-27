export type TenantRole = 'tenant_admin' | 'designer' | 'reviewer'
export type PlatformRole = 'platform_operator'
export interface SessionUser {
  userId: string
  username: string
  email: string
  displayName: string
  platformRole?: PlatformRole
  tenantId?: string
  tenantName?: string
  tenantRole?: TenantRole
  canCreateProject?: boolean
  canCreateIteration?: boolean
}
export interface AuthStatus { setupRequired: boolean; authenticated: boolean; user: SessionUser | null }

