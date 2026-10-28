import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import bcrypt from 'bcryptjs'
import type { Pool, PoolConnection, RowDataPacket, ExecuteValues } from 'mysql2/promise'
import { nanoid } from 'nanoid'
import { getPresetEndpoint, getPresetProtocols, providerPresets } from '../src/data/providerPresets'
import type { ProviderProtocol } from '../src/types/provider'

export type TenantRole = 'tenant_admin' | 'designer' | 'reviewer'
export type PlatformRole = 'platform_operator'
export type Actor = {
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

type Db = Pool | PoolConnection
type Input = Record<string, any>
const DEFAULT_TENANT_ID = 'default-tenant'
const SESSION_COOKIE = 'qp_session'
const CAPTCHA_COOKIE = 'qp_captcha_client'
const SESSION_MAX_AGE = 7 * 24 * 60 * 60
const CAPTCHA_MAX_AGE = 5 * 60 * 1000
const CAPTCHA_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

async function rows<T extends RowDataPacket[]>(db: Db, sql: string, values: ExecuteValues[] = []): Promise<T> {
  const [result] = await db.execute<T>(sql, values)
  return result
}

const AI_OPEN_ALL_SETTING = 'ai.models.open_all'

async function areAllAiModelsOpen(db: Db): Promise<boolean> {
  const result = await rows<RowDataPacket[]>(db, 'SELECT setting_value FROM platform_settings WHERE setting_key=? LIMIT 1', [AI_OPEN_ALL_SETTING])
  return String(result[0]?.setting_value ?? '0') === '1'
}

async function availableAiModelRows(db: Db): Promise<RowDataPacket[]> {
  if (await areAllAiModelsOpen(db)) {
    return rows<RowDataPacket[]>(db, 'SELECT id,provider_preset_id providerPresetId,provider_name providerName,protocol,model FROM ai_model_pool WHERE enabled=1 ORDER BY provider_name,model')
  }
  return rows<RowDataPacket[]>(db, 'SELECT p.id,p.provider_preset_id providerPresetId,p.provider_name providerName,p.protocol,p.model FROM ai_allowed_models a JOIN ai_model_pool p ON p.id=a.model WHERE p.enabled=1 ORDER BY p.provider_name,p.model')
}

function hashToken(token: string) { return createHash('sha256').update(token).digest('hex') }
function credentialKey() {
  const secret = process.env.QUICKPAGE_CREDENTIAL_KEY || process.env.MYSQL_PASSWORD || 'quickpage-local-credential-key'
  return createHash('sha256').update(secret).digest()
}
export function encryptCredential(value: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', credentialKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), encrypted].map((item) => item.toString('base64url')).join('.')
}
export function decryptCredential(value: string) {
  const [iv, tag, encrypted] = value.split('.').map((item) => Buffer.from(item, 'base64url'))
  if (!iv || !tag || !encrypted) throw new Error('账号密码信息已损坏')
  const decipher = createDecipheriv('aes-256-gcm', credentialKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
function cookieValue(req: IncomingMessage, key: string) {
  const cookie = req.headers.cookie ?? ''
  const entry = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${key}=`))
  return entry ? decodeURIComponent(entry.slice(key.length + 1)) : undefined
}
function appendCookie(res: ServerResponse, value: string) {
  const current = res.getHeader('set-cookie')
  res.setHeader('set-cookie', current ? [...(Array.isArray(current) ? current : [String(current)]), value] : value)
}
function setSessionCookie(res: ServerResponse, token: string) {
  appendCookie(res, `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`)
}
function clearSessionCookie(res: ServerResponse) {
  appendCookie(res, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}
function cleanEmail(value: unknown) { return String(value ?? '').trim().toLowerCase() }
function usernameBase(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '').slice(0, 48)
}
function validUsername(value: unknown, fallback?: string) {
  const username = usernameBase(value) || usernameBase(fallback)
  if (!/^[a-z0-9][a-z0-9._-]{2,47}$/.test(username)) throw new Error('登录账号需为 3-48 位字母、数字、点、下划线或短横线')
  return username
}
function required(value: unknown, label: string) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`请输入${label}`)
  return text
}
function validRole(value: unknown): TenantRole {
  if (value === 'tenant_admin' || value === 'designer' || value === 'reviewer') return value
  throw new Error('无效的成员角色')
}
type CaptchaPurpose = 'setup' | 'login' | 'register'
function validCaptchaPurpose(value: unknown): CaptchaPurpose {
  if (value === 'setup' || value === 'login' || value === 'register') return value
  throw new Error('无效的验证码用途')
}
function captchaClient(req: IncomingMessage, res?: ServerResponse) {
  const existing = cookieValue(req, CAPTCHA_COOKIE)
  if (existing) return existing
  if (!res) return ''
  const value = randomBytes(24).toString('base64url')
  appendCookie(res, `${CAPTCHA_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`)
  return value
}
function captchaCode() {
  if (process.env.QUICKPAGE_CAPTCHA_TEST_CODE) return process.env.QUICKPAGE_CAPTCHA_TEST_CODE.toUpperCase()
  const bytes = randomBytes(4)
  return [...bytes].map((value) => CAPTCHA_ALPHABET[value % CAPTCHA_ALPHABET.length]).join('')
}
function captchaSvg(code: string) {
  const colors = ['#312e81', '#1d4ed8', '#7e22ce', '#0f766e']
  const letters = [...code].map((letter, index) => {
    const x = 22 + index * 30, y = 38 + (index % 2 ? 3 : -2), rotate = (index % 2 ? 1 : -1) * (5 + index * 2)
    return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" fill="${colors[index % colors.length]}" font-size="27" font-family="Arial,sans-serif" font-weight="700">${letter}</text>`
  }).join('')
  const noise = Array.from({ length: 7 }, (_, index) => `<circle cx="${12 + index * 21}" cy="${10 + (index * 17) % 38}" r="${1 + index % 2}" fill="#94a3b8" opacity=".65"/>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="52" viewBox="0 0 150 52"><rect width="150" height="52" rx="7" fill="#f8fafc"/><path d="M4 35 C35 8 67 51 104 19 S142 34 148 12" stroke="#cbd5e1" stroke-width="2" fill="none"/>${noise}${letters}</svg>`
}
async function verifyCaptcha(pool: Pool, req: IncomingMessage, input: Input, purpose: CaptchaPurpose) {
  const id = required(input.captchaId, '验证码')
  const answer = required(input.captchaCode, '验证码').toUpperCase()
  const client = captchaClient(req)
  const result = await rows<RowDataPacket[]>(pool, 'SELECT code_hash,salt,purpose,expires_at,client_hash FROM captcha_challenges WHERE id=?', [id])
  await pool.execute('DELETE FROM captcha_challenges WHERE id=?', [id])
  const row = result[0]
  const expected = row ? hashToken(`${id}:${row.salt}:${answer}`) : ''
  if (!row || row.purpose !== purpose || Number(row.expires_at) < Date.now() || row.client_hash !== hashToken(client) || expected !== row.code_hash)
    throw Object.assign(new Error('验证码错误或已失效，请重新输入'), { statusCode: 400 })
}

export async function initializeSaas(pool: Pool) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS tenants (
      id VARCHAR(128) PRIMARY KEY, name VARCHAR(255) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, INDEX idx_tenants_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(128) PRIMARY KEY, username VARCHAR(48) NOT NULL, email VARCHAR(255) NOT NULL, display_name VARCHAR(255) NOT NULL, password_hash VARCHAR(255) NOT NULL,
      platform_role VARCHAR(32) NULL, status VARCHAR(32) NOT NULL DEFAULT 'active', last_login_at BIGINT NULL,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, UNIQUE KEY uk_users_username (username), UNIQUE KEY uk_users_email (email), INDEX idx_users_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_members (
      tenant_id VARCHAR(128) NOT NULL, user_id VARCHAR(128) NOT NULL, role VARCHAR(32) NOT NULL,
      can_create_project TINYINT(1) NOT NULL DEFAULT 0, can_create_iteration TINYINT(1) NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, user_id), INDEX idx_members_user (user_id),
      CONSTRAINT fk_members_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS project_members (
      project_id VARCHAR(128) NOT NULL, user_id VARCHAR(128) NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY (project_id, user_id), INDEX idx_project_members_user (user_id),
      CONSTRAINT fk_project_members_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_project_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id VARCHAR(128) PRIMARY KEY, token_hash CHAR(64) NOT NULL, user_id VARCHAR(128) NOT NULL, expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL, UNIQUE KEY uk_sessions_token (token_hash), INDEX idx_sessions_user (user_id), INDEX idx_sessions_expiry (expires_at),
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS token_usage (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(128) NOT NULL, project_id VARCHAR(128) NULL, page_id VARCHAR(128) NULL, user_id VARCHAR(128) NOT NULL,
      operation VARCHAR(64) NOT NULL, provider VARCHAR(64) NOT NULL, model VARCHAR(255) NOT NULL, input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0, total_tokens BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL,
      INDEX idx_usage_tenant_time (tenant_id, created_at), INDEX idx_usage_project_time (project_id, created_at), INDEX idx_usage_user_time (user_id, created_at),
      CONSTRAINT fk_usage_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY, tenant_id VARCHAR(128) NULL, user_id VARCHAR(128) NULL, action VARCHAR(96) NOT NULL, detail LONGTEXT NULL, created_at BIGINT NOT NULL,
      INDEX idx_audit_tenant_time (tenant_id, created_at), INDEX idx_audit_user_time (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS captcha_challenges (
      id VARCHAR(128) PRIMARY KEY, client_hash CHAR(64) NOT NULL, purpose VARCHAR(32) NOT NULL, code_hash CHAR(64) NOT NULL, salt VARCHAR(64) NOT NULL,
      expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, INDEX idx_captcha_expiry (expires_at), INDEX idx_captcha_client (client_hash, purpose)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS team_invitations (
      id VARCHAR(128) PRIMARY KEY, token_hash CHAR(64) NOT NULL, tenant_id VARCHAR(128) NOT NULL, role VARCHAR(32) NOT NULL, invited_by VARCHAR(128) NOT NULL,
      expires_at BIGINT NOT NULL, used_at BIGINT NULL, created_at BIGINT NOT NULL, UNIQUE KEY uk_team_invite_token (token_hash),
      INDEX idx_team_invite_tenant (tenant_id, created_at), INDEX idx_team_invite_expiry (expires_at),
      CONSTRAINT fk_team_invite_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT fk_team_invite_user FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS managed_credentials (
      user_id VARCHAR(128) PRIMARY KEY, tenant_id VARCHAR(128) NOT NULL, password_cipher LONGTEXT NOT NULL, updated_at BIGINT NOT NULL,
      INDEX idx_managed_credentials_tenant (tenant_id),
      CONSTRAINT fk_managed_credentials_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_managed_credentials_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ai_providers (
      id VARCHAR(128) PRIMARY KEY, owner_type VARCHAR(32) NOT NULL, owner_id VARCHAR(128) NULL, name VARCHAR(255) NOT NULL,
      protocol VARCHAR(32) NOT NULL, base_url VARCHAR(1024) NOT NULL, credential_cipher LONGTEXT NOT NULL, models LONGTEXT NOT NULL,
      preset_id VARCHAR(128) NULL, cors_hint VARCHAR(32) NOT NULL DEFAULT 'unknown', use_proxy TINYINT(1) NOT NULL DEFAULT 1, enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, INDEX idx_ai_provider_owner (owner_type,owner_id,enabled)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS tenant_ai_settings (
      tenant_id VARCHAR(128) PRIMARY KEY, analysis_provider_id VARCHAR(128) NULL, analysis_model VARCHAR(255) NULL,
      generation_provider_id VARCHAR(128) NULL, generation_model VARCHAR(255) NULL, updated_at BIGINT NOT NULL,
      CONSTRAINT fk_tenant_ai_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ai_allowed_models (
      model VARCHAR(384) PRIMARY KEY, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS platform_settings (
      setting_key VARCHAR(128) PRIMARY KEY, setting_value LONGTEXT NOT NULL, updated_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS ai_model_pool (
      id VARCHAR(384) PRIMARY KEY, provider_preset_id VARCHAR(128) NOT NULL, provider_name VARCHAR(255) NOT NULL,
      protocol VARCHAR(32) NOT NULL, model VARCHAR(255) NOT NULL, enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      UNIQUE KEY uk_ai_model_pool_provider_model (provider_preset_id,model), INDEX idx_ai_model_pool_enabled (enabled,provider_name,model)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ]
  for (const statement of statements) await pool.query(statement)
  await pool.query('ALTER TABLE ai_allowed_models MODIFY COLUMN model VARCHAR(384) NOT NULL')
  const userColumns = await rows<RowDataPacket[]>(pool, `SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users'`)
  const userColumnNames = new Set(userColumns.map((row) => String(row.column_name)))
  if (!userColumnNames.has('username')) await pool.query('ALTER TABLE users ADD COLUMN username VARCHAR(48) NULL AFTER id')
  const usersWithoutUsername = await rows<RowDataPacket[]>(pool, `SELECT id,email,display_name FROM users WHERE username IS NULL OR username='' ORDER BY created_at,id`)
  if (usersWithoutUsername.length) {
    const existingRows = await rows<RowDataPacket[]>(pool, `SELECT username FROM users WHERE username IS NOT NULL AND username<>''`)
    const used = new Set(existingRows.map((row) => String(row.username).toLowerCase()))
    for (const user of usersWithoutUsername) {
      const emailPrefix = String(user.email ?? '').split('@')[0]
      const base = usernameBase(user.display_name) || usernameBase(emailPrefix) || `user${String(user.id).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`
      let username = base.length >= 3 ? base : `${base || 'user'}001`, suffix = 2
      while (used.has(username)) username = `${base.slice(0, 42)}${suffix++}`
      used.add(username)
      await pool.execute('UPDATE users SET username=? WHERE id=?', [username, user.id])
    }
  }
  const usernameIndexes = await rows<RowDataPacket[]>(pool, `SELECT index_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='users' AND index_name='uk_users_username'`)
  await pool.query('ALTER TABLE users MODIFY COLUMN username VARCHAR(48) NOT NULL')
  if (!usernameIndexes.length) await pool.query('ALTER TABLE users ADD UNIQUE KEY uk_users_username (username)')
  const memberColumns = await rows<RowDataPacket[]>(pool, `SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='tenant_members'`)
  const memberColumnNames = new Set(memberColumns.map((row) => String(row.column_name)))
  if (!memberColumnNames.has('can_create_project')) await pool.query('ALTER TABLE tenant_members ADD COLUMN can_create_project TINYINT(1) NOT NULL DEFAULT 0 AFTER role')
  if (!memberColumnNames.has('can_create_iteration')) await pool.query('ALTER TABLE tenant_members ADD COLUMN can_create_iteration TINYINT(1) NOT NULL DEFAULT 0 AFTER can_create_project')
  const usageColumns = await rows<RowDataPacket[]>(pool, `SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='token_usage'`)
  const usageColumnNames = new Set(usageColumns.map((row) => String(row.column_name)))
  if (!usageColumnNames.has('channel_scope')) await pool.query(`ALTER TABLE token_usage ADD COLUMN channel_scope VARCHAR(32) NOT NULL DEFAULT 'tenant' AFTER model`)
  if (!usageColumnNames.has('provider_id')) await pool.query(`ALTER TABLE token_usage ADD COLUMN provider_id VARCHAR(128) NULL AFTER provider`)
  const projectColumns = await rows<RowDataPacket[]>(pool, `SELECT column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='projects'`)
  const columns = new Set(projectColumns.map((row) => String(row.column_name)))
  if (!columns.has('tenant_id')) await pool.query('ALTER TABLE projects ADD COLUMN tenant_id VARCHAR(128) NULL AFTER id, ADD INDEX idx_projects_tenant_updated (tenant_id, updated_at)')
  if (!columns.has('created_by')) await pool.query('ALTER TABLE projects ADD COLUMN created_by VARCHAR(128) NULL AFTER tenant_id')
  const now = Date.now()
  await pool.execute('INSERT IGNORE INTO platform_settings (setting_key,setting_value,updated_at) VALUES (?,?,?)', [AI_OPEN_ALL_SETTING,'0',now])
  await pool.execute('INSERT IGNORE INTO tenants (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)', [DEFAULT_TENANT_ID, '默认工作区', 'active', now, now])
  for (const preset of providerPresets) for (const model of preset.suggestedModels) {
    const id = `${preset.id}:${model}`
    await pool.execute(`INSERT INTO ai_model_pool (id,provider_preset_id,provider_name,protocol,model,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE provider_name=VALUES(provider_name),protocol=VALUES(protocol),model=VALUES(model),updated_at=VALUES(updated_at)`,
      [id,preset.id,preset.name,preset.protocol,model,1,now,now])
  }
  const legacyAllowedModels=await rows<RowDataPacket[]>(pool,`SELECT a.model FROM ai_allowed_models a LEFT JOIN ai_model_pool p ON p.id=a.model WHERE p.id IS NULL`)
  for(const legacy of legacyAllowedModels){
    const model=String(legacy.model), matches=await rows<RowDataPacket[]>(pool,'SELECT id FROM ai_model_pool WHERE model=? AND enabled=1',[model])
    if(matches.length){await pool.execute('DELETE FROM ai_allowed_models WHERE model=?',[model]);for(const match of matches)await pool.execute('INSERT IGNORE INTO ai_allowed_models (model,created_at,updated_at) VALUES (?,?,?)',[match.id,now,now])}
  }
  await pool.execute('UPDATE projects SET tenant_id=? WHERE tenant_id IS NULL', [DEFAULT_TENANT_ID])
  await pool.execute('DELETE FROM sessions WHERE expires_at < ?', [now])
  await pool.execute('DELETE FROM captcha_challenges WHERE expires_at < ?', [now])
  await pool.execute('DELETE FROM team_invitations WHERE expires_at < ? OR used_at IS NOT NULL', [now - 7 * 24 * 60 * 60 * 1000])
}

function providerDto(row: RowDataPacket) {
  return {
    id: String(row.id), name: String(row.name), protocol: row.protocol, baseUrl: String(row.base_url), apiKey: '',
    models: typeof row.models === 'string' ? JSON.parse(row.models) : row.models, presetId: row.preset_id || undefined,
    corsHint: row.cors_hint || 'unknown', useProxy: true, managed: true, source: row.owner_type, hasCredential: !!row.credential_cipher,
  }
}

export async function resolveManagedAiProvider(pool: Pool, actor: Actor | null, providerId: string) {
  const user = requireActor(actor)
  const result = await rows<RowDataPacket[]>(pool, `SELECT * FROM ai_providers WHERE id=? AND enabled=1 AND (owner_type='platform' OR (owner_type='tenant' AND owner_id=?)) LIMIT 1`, [providerId, user.tenantId ?? ''])
  const row = result[0]
  if (!row) throw Object.assign(new Error('AI 服务通道不存在或未开放'), { statusCode: 404 })
  return { ...providerDto(row), apiKey: decryptCredential(String(row.credential_cipher)) }
}

export async function actorFromRequest(pool: Pool, req: IncomingMessage): Promise<Actor | null> {
  const token = cookieValue(req, SESSION_COOKIE)
  if (!token) return null
  const now = Date.now()
  const result = await rows<RowDataPacket[]>(pool, `SELECT u.id user_id,u.username,u.email,u.display_name,u.platform_role,u.status user_status,
      tm.tenant_id,tm.role tenant_role,tm.can_create_project,tm.can_create_iteration,t.name tenant_name,t.status tenant_status,s.id session_id
    FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN tenant_members tm ON tm.user_id=u.id
    LEFT JOIN tenants t ON t.id=tm.tenant_id
    WHERE s.token_hash=? AND s.expires_at>? ORDER BY tm.created_at LIMIT 1`, [hashToken(token), now])
  const row = result[0]
  if (!row || row.user_status !== 'active' || (row.tenant_id && row.tenant_status !== 'active' && !row.platform_role)) return null
  await pool.execute('UPDATE sessions SET last_seen_at=? WHERE id=?', [now, row.session_id])
  const tenantRole = row.tenant_role as TenantRole | undefined
  return {
    userId: row.user_id, username: row.username, email: row.email, displayName: row.display_name, platformRole: row.platform_role || undefined,
    tenantId: row.tenant_id || undefined, tenantName: row.tenant_name || undefined, tenantRole,
    canCreateProject: tenantRole === 'tenant_admin' || (tenantRole === 'designer' && Boolean(row.can_create_project)),
    canCreateIteration: tenantRole === 'tenant_admin' || (tenantRole === 'designer' && Boolean(row.can_create_iteration)),
  }
}

export async function setupRequired(pool: Pool) {
  const count = await rows<RowDataPacket[]>(pool, 'SELECT COUNT(*) count FROM users')
  return Number(count[0]?.count ?? 0) === 0
}

async function createSession(pool: Pool, userId: string, res: ServerResponse) {
  const token = randomBytes(32).toString('base64url'), now = Date.now()
  await pool.execute('INSERT INTO sessions (id,token_hash,user_id,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?)', [nanoid(), hashToken(token), userId, now + SESSION_MAX_AGE * 1000, now, now])
  setSessionCookie(res, token)
}

function publicActor(actor: Actor | null, requiredSetup: boolean) { return { setupRequired: requiredSetup, authenticated: !!actor, user: actor } }
export function requireActor(actor: Actor | null): Actor { if (!actor) throw Object.assign(new Error('请先登录'), { statusCode: 401 }); return actor }
export function requireTenantAdmin(actor: Actor | null): Actor {
  const value = requireActor(actor)
  if (value.tenantRole !== 'tenant_admin') throw Object.assign(new Error('仅管理员可执行此操作'), { statusCode: 403 })
  return value
}
export function requireOperator(actor: Actor | null): Actor {
  const value = requireActor(actor)
  if (value.platformRole !== 'platform_operator') throw Object.assign(new Error('仅运营端管理员可执行此操作'), { statusCode: 403 })
  return value
}
export function canWrite(actor: Actor) { return actor.tenantRole === 'tenant_admin' || actor.tenantRole === 'designer' }
export function canCreateProject(actor: Actor) { return actor.tenantRole === 'tenant_admin' || (actor.tenantRole === 'designer' && actor.canCreateProject === true) }
export function canCreateIteration(actor: Actor) { return actor.tenantRole === 'tenant_admin' || (actor.tenantRole === 'designer' && actor.canCreateIteration === true) }
export function requireProjectCreator(actor: Actor | null): Actor {
  const value = requireActor(actor)
  if (!canCreateProject(value)) throw Object.assign(new Error('管理员尚未授权你创建项目'), { statusCode: 403 })
  return value
}
export function requireIterationCreator(actor: Actor | null): Actor {
  const value = requireActor(actor)
  if (!canCreateIteration(value)) throw Object.assign(new Error('管理员尚未授权你创建项目版本'), { statusCode: 403 })
  return value
}

export async function resolveProjectAccess(db: Db, actor: Actor, projectId: string, mode: 'read' | 'write') {
  const result = await rows<RowDataPacket[]>(db, `SELECT p.id,p.tenant_id,p.data,EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=?) assigned FROM projects p WHERE p.id=?`, [actor.userId, projectId])
  const row = result[0]
  if (!row || !actor.tenantId || row.tenant_id !== actor.tenantId) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  const admin = actor.tenantRole === 'tenant_admin'
  if (!admin && !row.assigned) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  if (actor.tenantRole === 'reviewer' && data.hidden) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  if (mode === 'write' && !canWrite(actor)) throw Object.assign(new Error('审阅者仅可查看原型，不能编辑'), { statusCode: 403 })
  return { data, tenantId: row.tenant_id as string }
}

async function audit(db: Db, actor: Actor, action: string, detail?: unknown) {
  await db.execute('INSERT INTO audit_logs (tenant_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?)', [actor.tenantId ?? null, actor.userId, action, detail ? JSON.stringify(detail) : null, Date.now()])
}

export async function dispatchSaas(pool: Pool, action: string, input: Input, req: IncomingMessage, res: ServerResponse, actor: Actor | null): Promise<unknown> {
  if (action === 'auth.status') return publicActor(actor, await setupRequired(pool))
  if (action === 'auth.captcha') {
    const purpose = validCaptchaPurpose(input.purpose)
    const client = captchaClient(req, res), clientHash = hashToken(client), id = nanoid(), salt = randomBytes(12).toString('hex'), code = captchaCode(), now = Date.now()
    await pool.execute('DELETE FROM captcha_challenges WHERE expires_at < ? OR (client_hash=? AND purpose=?)', [now, clientHash, purpose])
    await pool.execute('INSERT INTO captcha_challenges (id,client_hash,purpose,code_hash,salt,expires_at,created_at) VALUES (?,?,?,?,?,?,?)', [id, clientHash, purpose, hashToken(`${id}:${salt}:${code}`), salt, now + CAPTCHA_MAX_AGE, now])
    return { id, image: `data:image/svg+xml;base64,${Buffer.from(captchaSvg(code)).toString('base64')}`, expiresIn: CAPTCHA_MAX_AGE / 1000 }
  }
  if (action === 'auth.invite.info') {
    const token = required(input.token, '邀请链接')
    const result = await rows<RowDataPacket[]>(pool, `SELECT i.role,i.expires_at expiresAt,i.used_at usedAt,t.name tenantName,t.status tenantStatus
      FROM team_invitations i JOIN tenants t ON t.id=i.tenant_id WHERE i.token_hash=? LIMIT 1`, [hashToken(token)])
    const invitation = result[0]
    if (!invitation || invitation.usedAt || Number(invitation.expiresAt) <= Date.now() || invitation.tenantStatus !== 'active') throw Object.assign(new Error('邀请链接无效或已过期'), { statusCode: 410 })
    return { tenantName: invitation.tenantName, role: invitation.role, expiresAt: Number(invitation.expiresAt) }
  }
  if (action === 'auth.invite.accept') {
    await verifyCaptcha(pool, req, input, 'register')
    const token = required(input.token, '邀请链接'), email = cleanEmail(input.email), username = validUsername(input.username, email.split('@')[0])
    const displayName = required(input.displayName, '姓名'), password = required(input.password, '密码')
    if (!email.includes('@')) throw new Error('请输入有效邮箱')
    if (password.length < 8) throw new Error('密码至少 8 位')
    const duplicate = await rows<RowDataPacket[]>(pool, 'SELECT email,username FROM users WHERE email=? OR username=?', [email, username])
    if (duplicate.length) throw Object.assign(new Error(duplicate[0].email === email ? '该邮箱已注册，请直接登录' : '该登录账号已被使用'), { statusCode: 409 })
    const connection = await pool.getConnection(), now = Date.now(), userId = nanoid(), passwordHash = await bcrypt.hash(password, 12)
    try {
      await connection.beginTransaction()
      const invitations = await rows<RowDataPacket[]>(connection, `SELECT i.id,i.tenant_id tenantId,i.role,i.expires_at expiresAt,i.used_at usedAt,t.status tenantStatus
        FROM team_invitations i JOIN tenants t ON t.id=i.tenant_id WHERE i.token_hash=? FOR UPDATE`, [hashToken(token)])
      const invitation = invitations[0]
      if (!invitation || invitation.usedAt || Number(invitation.expiresAt) <= now || invitation.tenantStatus !== 'active') throw Object.assign(new Error('邀请链接无效或已过期'), { statusCode: 410 })
      await connection.execute('INSERT INTO users (id,username,email,display_name,password_hash,status,last_login_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', [userId, username, email, displayName, passwordHash, 'active', now, now, now])
      await connection.execute('INSERT INTO tenant_members (tenant_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)', [invitation.tenantId, userId, invitation.role, now, now])
      await connection.execute('UPDATE team_invitations SET used_at=? WHERE id=?', [now, invitation.id])
      await connection.execute('INSERT INTO audit_logs (tenant_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?)', [invitation.tenantId, userId, 'team.invite.accept', JSON.stringify({ username, email, role: invitation.role }), now])
      await connection.commit()
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
    await createSession(pool, userId, res)
    return { ok: true, destination: '/' }
  }
  if (action === 'auth.setup') {
    await verifyCaptcha(pool, req, input, 'setup')
    if (!(await setupRequired(pool))) throw Object.assign(new Error('系统已完成初始化'), { statusCode: 409 })
    const email = cleanEmail(input.email), username = validUsername(input.username, email.split('@')[0]), password = required(input.password, '密码'), displayName = required(input.displayName, '姓名'), tenantName = required(input.tenantName, 'SaaS 名称')
    if (!email.includes('@')) throw new Error('请输入有效邮箱')
    if (password.length < 8) throw new Error('密码至少 8 位')
    const id = nanoid(), now = Date.now(), passwordHash = await bcrypt.hash(password, 12)
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute('UPDATE tenants SET name=?,updated_at=? WHERE id=?', [tenantName, now, DEFAULT_TENANT_ID])
      await connection.execute('INSERT INTO users (id,username,email,display_name,password_hash,platform_role,status,last_login_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [id,username,email,displayName,passwordHash,'platform_operator','active',now,now,now])
      await connection.execute('INSERT INTO tenant_members (tenant_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)', [DEFAULT_TENANT_ID,id,'tenant_admin',now,now])
      await connection.execute('UPDATE projects SET created_by=COALESCE(created_by,?) WHERE tenant_id=?', [id, DEFAULT_TENANT_ID])
      await connection.commit()
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
    await createSession(pool, id, res)
    return { ok: true, destination: '/ops' }
  }
  if (action === 'auth.register') {
    await verifyCaptcha(pool, req, input, 'register')
    if (await setupRequired(pool)) throw Object.assign(new Error('平台尚未初始化，请先创建平台管理员'), { statusCode: 409 })
    const tenantName = required(input.tenantName, '企业名称')
    const displayName = required(input.displayName, '管理员姓名')
    const email = cleanEmail(input.email)
    const username = validUsername(input.username, email.split('@')[0])
    const password = required(input.password, '密码')
    if (!email.includes('@')) throw new Error('请输入有效邮箱')
    if (password.length < 8) throw new Error('密码至少 8 位')
    const duplicate = await rows<RowDataPacket[]>(pool, 'SELECT email,username FROM users WHERE email=? OR username=?', [email, username])
    if (duplicate.length) throw Object.assign(new Error(duplicate[0].email === email ? '该邮箱已注册，请直接登录' : '该登录账号已被使用'), { statusCode: 409 })
    const tenantId = nanoid(), userId = nanoid(), now = Date.now()
    const passwordHash = await bcrypt.hash(password, 12)
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute('INSERT INTO tenants (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)', [tenantId, tenantName, 'active', now, now])
      await connection.execute('INSERT INTO users (id,username,email,display_name,password_hash,status,last_login_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', [userId, username, email, displayName, passwordHash, 'active', now, now, now])
      await connection.execute('INSERT INTO tenant_members (tenant_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)', [tenantId, userId, 'tenant_admin', now, now])
      await connection.execute('INSERT INTO audit_logs (tenant_id,user_id,action,detail,created_at) VALUES (?,?,?,?,?)', [tenantId, userId, 'auth.enterprise_register', JSON.stringify({ username, email, tenantName }), now])
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    await createSession(pool, userId, res)
    return { ok: true, tenantId, userId }
  }
  if (action === 'auth.login') {
    await verifyCaptcha(pool, req, input, 'login')
    const identifier = String(input.identifier ?? input.email ?? '').trim().toLowerCase(), password = String(input.password ?? '')
    const result = await rows<RowDataPacket[]>(pool, 'SELECT id,email,username,password_hash,status FROM users WHERE email=? OR username=? LIMIT 1', [identifier, identifier])
    const user = result[0]
    if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.password_hash))) throw Object.assign(new Error('账号、邮箱或密码错误'), { statusCode: 401 })
    const access = await rows<RowDataPacket[]>(pool, 'SELECT u.platform_role platformRole,t.status tenantStatus FROM users u LEFT JOIN tenant_members tm ON tm.user_id=u.id LEFT JOIN tenants t ON t.id=tm.tenant_id WHERE u.id=? ORDER BY tm.created_at LIMIT 1', [user.id])
    if (!access[0]?.platformRole && access[0]?.tenantStatus !== 'active') {
      throw Object.assign(new Error('当前企业或团队已暂停，请联系平台运营管理员'), { statusCode: 403 })
    }
    const now = Date.now()
    await pool.execute('UPDATE users SET last_login_at=?,updated_at=? WHERE id=?', [now, now, user.id])
    await pool.execute('INSERT INTO audit_logs (user_id,action,detail,created_at) VALUES (?,?,?,?)', [user.id, 'auth.login', JSON.stringify({ identifier, email: user.email, username: user.username }), now])
    await createSession(pool, user.id, res)
    return { ok: true, destination: access[0]?.platformRole === 'platform_operator' ? '/ops' : '/' }
  }
  if (action === 'auth.profile.update') {
    const user = requireActor(actor)
    const email = cleanEmail(input.email), username = validUsername(input.username, email.split('@')[0]), displayName = required(input.displayName, '姓名')
    if (!email.includes('@')) throw new Error('请输入有效邮箱')
    const duplicate = await rows<RowDataPacket[]>(pool, 'SELECT id,email,username FROM users WHERE id<>? AND (email=? OR username=?) LIMIT 1', [user.userId, email, username])
    if (duplicate.length) throw Object.assign(new Error(duplicate[0].email === email ? '该邮箱已存在' : '该登录账号已存在'), { statusCode: 409 })
    const newPassword = String(input.newPassword ?? '')
    if (newPassword) {
      if (newPassword.length < 8) throw new Error('新密码至少 8 位')
      const currentPassword = required(input.currentPassword, '当前密码')
      const passwordRow = await rows<RowDataPacket[]>(pool, 'SELECT password_hash FROM users WHERE id=?', [user.userId])
      if (!passwordRow[0] || !(await bcrypt.compare(currentPassword, passwordRow[0].password_hash))) throw Object.assign(new Error('当前密码错误'), { statusCode: 400 })
      const now = Date.now(), passwordHash = await bcrypt.hash(newPassword, 12)
      await pool.execute('UPDATE users SET username=?,email=?,display_name=?,password_hash=?,updated_at=? WHERE id=?', [username, email, displayName, passwordHash, now, user.userId])
      await pool.execute('UPDATE managed_credentials SET password_cipher=?,updated_at=? WHERE user_id=?', [encryptCredential(newPassword), now, user.userId])
    } else {
      await pool.execute('UPDATE users SET username=?,email=?,display_name=?,updated_at=? WHERE id=?', [username, email, displayName, Date.now(), user.userId])
    }
    await audit(pool, { ...user, username, email, displayName }, 'auth.profile.update', { username, email, displayName, passwordChanged: !!newPassword })
    return { ok: true }
  }
  if (action === 'auth.logout') {
    const token = cookieValue(req, SESSION_COOKIE)
    if (token) await pool.execute('DELETE FROM sessions WHERE token_hash=?', [hashToken(token)])
    clearSessionCookie(res)
    return { ok: true }
  }
  if (action === 'ai.config.get') {
    const user = requireActor(actor)
    if (!user.tenantId) return { providers: [], modelSelection: { analysis: null, generation: null } }
    const providerRows = await rows<RowDataPacket[]>(pool, `SELECT * FROM ai_providers WHERE enabled=1 AND (owner_type='platform' OR (owner_type='tenant' AND owner_id=?)) ORDER BY owner_type DESC,created_at`, [user.tenantId])
    const settings = await rows<RowDataPacket[]>(pool, 'SELECT * FROM tenant_ai_settings WHERE tenant_id=?', [user.tenantId])
    const current = settings[0]
    const allowedRows = await availableAiModelRows(pool)
    const allowedModels = allowedRows.map((row) => String(row.model))
    const allowedIds = new Set(allowedRows.map((row) => String(row.id)))
    const allowedPresetModels: Record<string,string[]> = {}
    for(const row of allowedRows){const presetId=String(row.providerPresetId);(allowedPresetModels[presetId]??=[]).push(String(row.model))}
    return {
      providers: providerRows.map(providerDto).map((provider) => {
        if(provider.source==='tenant'&&!provider.presetId)return provider
        const poolProviderId=provider.presetId||`platform-${provider.id}`
        return {...provider,models:provider.models.filter((model:string)=>allowedIds.has(`${poolProviderId}:${model}`))}
      }),
      allowedModels,
      allowedPresetModels,
      modelSelection: {
        analysis: current?.analysis_provider_id ? { providerId: current.analysis_provider_id, model: current.analysis_model } : null,
        generation: current?.generation_provider_id ? { providerId: current.generation_provider_id, model: current.generation_model } : null,
      },
    }
  }
  if (action === 'ai.tenant.provider.upsert') {
    const admin = requireTenantAdmin(actor), provider = input.provider ?? {}, id = required(provider.id, '服务商标识')
    const existing = await rows<RowDataPacket[]>(pool, `SELECT credential_cipher FROM ai_providers WHERE id=? AND owner_type='tenant' AND owner_id=?`, [id, admin.tenantId!])
    const apiKey = String(provider.apiKey ?? '').trim()
    if (!apiKey && !existing[0]?.credential_cipher) throw new Error('请输入 API Key')
    const models=Array.isArray(provider.models)?provider.models.map(String):[]
    const presetId=String(provider.presetId??'').trim(), preset=presetId?providerPresets.find((item)=>item.id===presetId):undefined
    let providerName=required(provider.name,'服务商名称'), protocol: ProviderProtocol=provider.protocol==='anthropic'?'anthropic':'openai', baseUrl=required(provider.baseUrl,'Base URL'), corsHint=provider.corsHint||'unknown'
    if(presetId){
      if(!preset)throw new Error('该服务商预设未被平台支持')
      if(!getPresetProtocols(preset).includes(protocol))throw new Error('服务商协议不符合平台预设规范')
      const endpoint=getPresetEndpoint(preset,protocol)
      if(!endpoint)throw new Error('服务商地址不符合平台预设规范')
      const available=await availableAiModelRows(pool),allowedSet=new Set(available.filter((row)=>String(row.providerPresetId)===presetId).map((row)=>String(row.model)))
      if(!allowedSet.size)throw new Error('该服务商尚未由平台开放')
      if(!models.length||models.some((model:string)=>!allowedSet.has(model)))throw new Error('请选择平台为该服务商开放的模型')
      providerName=preset.name;corsHint=preset.corsHint
    } else if(!models.length) throw new Error('自定义服务商请至少填写一个模型')
    const now = Date.now(), cipher = apiKey ? encryptCredential(apiKey) : existing[0].credential_cipher
    await pool.execute(`INSERT INTO ai_providers (id,owner_type,owner_id,name,protocol,base_url,credential_cipher,models,preset_id,cors_hint,use_proxy,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),protocol=VALUES(protocol),base_url=VALUES(base_url),credential_cipher=VALUES(credential_cipher),models=VALUES(models),preset_id=VALUES(preset_id),cors_hint=VALUES(cors_hint),use_proxy=1,enabled=1,updated_at=VALUES(updated_at)`,
      [id,'tenant',admin.tenantId!,providerName,protocol,baseUrl,cipher,JSON.stringify(models),presetId||null,corsHint,1,1,now,now])
    await audit(pool,admin,'ai.tenant.provider.upsert',{providerId:id}); return {ok:true}
  }
  if (action === 'ai.tenant.provider.remove') {
    const admin=requireTenantAdmin(actor), providerId=required(input.providerId,'服务商')
    await pool.execute(`DELETE FROM ai_providers WHERE id=? AND owner_type='tenant' AND owner_id=?`,[providerId,admin.tenantId!])
    await pool.execute(`UPDATE tenant_ai_settings SET analysis_provider_id=IF(analysis_provider_id=?,NULL,analysis_provider_id),analysis_model=IF(analysis_provider_id IS NULL,NULL,analysis_model),generation_provider_id=IF(generation_provider_id=?,NULL,generation_provider_id),generation_model=IF(generation_provider_id IS NULL,NULL,generation_model),updated_at=? WHERE tenant_id=?`,[providerId,providerId,Date.now(),admin.tenantId!])
    return {ok:true}
  }
  if (action === 'ai.tenant.selection.update') {
    const admin=requireTenantAdmin(actor), selection=input.modelSelection??{}, analysis=selection.analysis??{}, generation=selection.generation??{}
    for (const ref of [analysis,generation]) if (ref.providerId) {
      const found=await rows<RowDataPacket[]>(pool,`SELECT id,owner_type,preset_id,models FROM ai_providers WHERE id=? AND enabled=1 AND (owner_type='platform' OR (owner_type='tenant' AND owner_id=?))`,[ref.providerId,admin.tenantId!])
      if(!found.length) throw new Error('选择的模型通道不可用')
      const models=typeof found[0].models==='string'?JSON.parse(found[0].models):found[0].models
      if(!models.includes(ref.model))throw new Error('选择的模型不属于当前服务商')
      if(found[0].owner_type==='platform'||found[0].preset_id){const poolProviderId=found[0].preset_id||`platform-${found[0].id}`;const allowed=(await availableAiModelRows(pool)).some((row)=>String(row.id)===`${poolProviderId}:${ref.model}`);if(!allowed)throw new Error('选择的模型未被平台运营端开放')}
    }
    await pool.execute(`INSERT INTO tenant_ai_settings (tenant_id,analysis_provider_id,analysis_model,generation_provider_id,generation_model,updated_at) VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE analysis_provider_id=VALUES(analysis_provider_id),analysis_model=VALUES(analysis_model),generation_provider_id=VALUES(generation_provider_id),generation_model=VALUES(generation_model),updated_at=VALUES(updated_at)`,
      [admin.tenantId!,analysis.providerId||null,analysis.model||null,generation.providerId||null,generation.model||null,Date.now()]); return {ok:true}
  }
  if (action === 'saas.team.list') {
    const admin = requireTenantAdmin(actor)
    const result = await rows<RowDataPacket[]>(pool, `SELECT u.id,u.username,u.email,u.display_name displayName,u.status,u.last_login_at lastLoginAt,tm.role,
      CASE WHEN tm.role='tenant_admin' THEN 1 WHEN tm.role='designer' THEN tm.can_create_project ELSE 0 END canCreateProject,
      CASE WHEN tm.role='tenant_admin' THEN 1 WHEN tm.role='designer' THEN tm.can_create_iteration ELSE 0 END canCreateIteration,
      (SELECT COUNT(DISTINCT COALESCE(p.family_id,p.id)) FROM project_members pm JOIN projects p ON p.id=pm.project_id WHERE pm.user_id=u.id) projectCount FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=? ORDER BY tm.created_at`, [admin.tenantId!])
    return result.map((item) => ({ ...item, canCreateProject: Boolean(item.canCreateProject), canCreateIteration: Boolean(item.canCreateIteration) }))
  }
  if (action === 'saas.team.create') {
    const admin = requireTenantAdmin(actor), role = validRole(input.role), email = cleanEmail(input.email), username = validUsername(input.username, email.split('@')[0]), displayName = required(input.displayName, '姓名'), password = required(input.password, '初始密码')
    if (!email.includes('@')) throw new Error('请输入有效邮箱')
    if (password.length < 8) throw new Error('初始密码至少 8 位')
    const existing = await rows<RowDataPacket[]>(pool, 'SELECT email,username FROM users WHERE email=? OR username=?', [email, username])
    if (existing.length) throw new Error(existing[0].email === email ? '该邮箱已存在' : '该登录账号已存在')
    const id=nanoid(), now=Date.now(), passwordHash=await bcrypt.hash(password,12)
    await pool.execute('INSERT INTO users (id,username,email,display_name,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [id,username,email,displayName,passwordHash,'active',now,now])
    await pool.execute('INSERT INTO tenant_members (tenant_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)', [admin.tenantId!,id,role,now,now])
    await audit(pool, admin, 'team.create', { userId:id,email,role })
    return { id }
  }
  if (action === 'saas.invite.create') {
    const admin = requireTenantAdmin(actor), role = validRole(input.role)
    if (role === 'tenant_admin') throw new Error('邀请角色仅支持设计员或审阅者')
    const expiresHours = Math.min(168, Math.max(1, Number(input.expiresHours) || 24))
    const token = randomBytes(9).toString('base64url'), now = Date.now(), expiresAt = now + expiresHours * 60 * 60 * 1000
    await pool.execute('INSERT INTO team_invitations (id,token_hash,tenant_id,role,invited_by,expires_at,created_at) VALUES (?,?,?,?,?,?,?)', [nanoid(), hashToken(token), admin.tenantId!, role, admin.userId, expiresAt, now])
    await audit(pool, admin, 'team.invite.create', { role, expiresAt })
    return { token, path: `/invite/${token}`, role, expiresAt, tenantName: admin.tenantName }
  }
  if (action === 'saas.team.update') {
    const admin=requireTenantAdmin(actor), userId=required(input.userId,'成员'), role=validRole(input.role), status=input.status === 'disabled' ? 'disabled' : 'active'
    const canCreateProject = role === 'tenant_admin' ? 1 : role === 'designer' && input.canCreateProject === true ? 1 : 0
    const canCreateIteration = role === 'tenant_admin' ? 1 : role === 'designer' && input.canCreateIteration === true ? 1 : 0
    if (userId === admin.userId && (role !== 'tenant_admin' || status !== 'active')) throw new Error('不能停用自己或移除自己的管理员权限')
    const member=await rows<RowDataPacket[]>(pool,'SELECT 1 FROM tenant_members WHERE tenant_id=? AND user_id=?',[admin.tenantId!,userId]); if(!member.length) throw new Error('成员不存在')
    await pool.execute('UPDATE tenant_members SET role=?,can_create_project=?,can_create_iteration=?,updated_at=? WHERE tenant_id=? AND user_id=?',[role,canCreateProject,canCreateIteration,Date.now(),admin.tenantId!,userId])
    await pool.execute('UPDATE users SET status=?,updated_at=? WHERE id=?',[status,Date.now(),userId])
    await audit(pool,admin,'team.update',{userId,role,status,canCreateProject:Boolean(canCreateProject),canCreateIteration:Boolean(canCreateIteration)}); return {ok:true}
  }
  if (action === 'saas.team.profile.update') {
    const admin = requireTenantAdmin(actor), userId = required(input.userId, '成员'), email = cleanEmail(input.email), username = validUsername(input.username, email.split('@')[0]), displayName = required(input.displayName, '姓名')
    if (!email.includes('@')) throw new Error('请输入有效邮箱')
    const member = await rows<RowDataPacket[]>(pool, 'SELECT 1 FROM tenant_members WHERE tenant_id=? AND user_id=?', [admin.tenantId!, userId])
    if (!member.length) throw Object.assign(new Error('成员不存在'), { statusCode: 404 })
    const duplicate = await rows<RowDataPacket[]>(pool, 'SELECT id,email,username FROM users WHERE id<>? AND (email=? OR username=?) LIMIT 1', [userId, email, username])
    if (duplicate.length) throw Object.assign(new Error(duplicate[0].email === email ? '该邮箱已存在' : '该登录账号已存在'), { statusCode: 409 })
    await pool.execute('UPDATE users SET username=?,email=?,display_name=?,updated_at=? WHERE id=?', [username, email, displayName, Date.now(), userId])
    await audit(pool, admin, 'team.profile.update', { userId, username, email, displayName })
    return { ok: true }
  }
  if (action === 'saas.team.resetPassword') {
    const admin = requireTenantAdmin(actor), userId = required(input.userId, '成员'), password = required(input.password, '临时密码')
    if (password.length < 8) throw new Error('临时密码至少 8 位')
    const member = await rows<RowDataPacket[]>(pool, 'SELECT 1 FROM tenant_members WHERE tenant_id=? AND user_id=?', [admin.tenantId!, userId])
    if (!member.length) throw new Error('成员不存在')
    const passwordHash = await bcrypt.hash(password, 12)
    await pool.execute('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', [passwordHash, Date.now(), userId])
    await audit(pool, admin, 'team.password.reset', { userId })
    return { ok: true }
  }
  if (action === 'saas.assignments.list') {
    const admin=requireTenantAdmin(actor)
    const projects=await rows<RowDataPacket[]>(pool,`SELECT COALESCE(family_id,id) familyId,
      MAX(JSON_UNQUOTE(JSON_EXTRACT(data,'$.name'))) name, COUNT(*) iterationCount,
      GROUP_CONCAT(JSON_UNQUOTE(JSON_EXTRACT(data,'$.iteration')) ORDER BY updated_at DESC SEPARATOR '、') iterations,
      MAX(updated_at) updatedAt FROM projects WHERE tenant_id=? GROUP BY COALESCE(family_id,id) ORDER BY updatedAt DESC`,[admin.tenantId!])
    const members=await rows<RowDataPacket[]>(pool,`SELECT u.id,u.username,u.display_name displayName,u.email,tm.role FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=? AND u.status='active' ORDER BY u.display_name`,[admin.tenantId!])
    const assigned=await rows<RowDataPacket[]>(pool,`SELECT COALESCE(p.family_id,p.id) familyId,pm.user_id userId
      FROM project_members pm JOIN projects p ON p.id=pm.project_id
      JOIN tenant_members tm ON tm.user_id=pm.user_id AND tm.tenant_id=p.tenant_id
      WHERE p.tenant_id=? AND tm.role IN ('designer','reviewer') GROUP BY COALESCE(p.family_id,p.id),pm.user_id`,[admin.tenantId!])
    return { projects, members, assigned }
  }
  if (action === 'saas.assignments.update') {
    const admin=requireTenantAdmin(actor), familyId=required(input.familyId ?? input.projectId,'项目'), userIds: string[]=[...new Set<string>((input.userIds??[]).map((value: unknown) => String(value)))]
    const familyProjects=await rows<RowDataPacket[]>(pool,'SELECT id FROM projects WHERE tenant_id=? AND COALESCE(family_id,id)=? ORDER BY id',[admin.tenantId!,familyId])
    if(!familyProjects.length) throw Object.assign(new Error('项目不存在'),{statusCode:404})
    if(userIds.length){ const placeholders=userIds.map(()=>'?').join(','); const valid=await rows<RowDataPacket[]>(pool,`SELECT user_id FROM tenant_members WHERE tenant_id=? AND user_id IN (${placeholders})`,[admin.tenantId!,...userIds]); if(valid.length!==userIds.length) throw new Error('包含不属于当前 SaaS 的成员') }
    const projectIds=familyProjects.map((row)=>String(row.id)), placeholders=projectIds.map(()=>'?').join(','), connection=await pool.getConnection()
    try{ await connection.beginTransaction(); await connection.execute(`DELETE FROM project_members WHERE project_id IN (${placeholders})`,projectIds); for(const projectId of projectIds) for(const userId of userIds) await connection.execute('INSERT INTO project_members (project_id,user_id,created_at) VALUES (?,?,?)',[projectId,userId,Date.now()]); await connection.commit() }catch(error){await connection.rollback();throw error}finally{connection.release()}
    await audit(pool,admin,'project.assign',{familyId,projectIds,userIds}); return {ok:true}
  }
  if (action === 'saas.usage.summary') {
    const admin=requireTenantAdmin(actor)
    const totals=await rows<RowDataPacket[]>(pool,'SELECT COALESCE(SUM(total_tokens),0) totalTokens,COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(output_tokens),0) outputTokens,COUNT(*) calls FROM token_usage WHERE tenant_id=?',[admin.tenantId!])
    const projects=await rows<RowDataPacket[]>(pool,`SELECT tu.project_id projectId,COALESCE(SUM(tu.total_tokens),0) totalTokens,COUNT(*) calls,p.data FROM token_usage tu LEFT JOIN projects p ON p.id=tu.project_id WHERE tu.tenant_id=? GROUP BY tu.project_id,p.data ORDER BY totalTokens DESC`,[admin.tenantId!])
    const channels=await rows<RowDataPacket[]>(pool,`SELECT channel_scope channelScope,provider,model,COUNT(*) calls,COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(output_tokens),0) outputTokens,COALESCE(SUM(total_tokens),0) totalTokens FROM token_usage WHERE tenant_id=? GROUP BY channel_scope,provider,model ORDER BY totalTokens DESC`,[admin.tenantId!])
    return { totals: totals[0], projects: projects.map((row)=>({projectId:row.projectId,totalTokens:Number(row.totalTokens),calls:Number(row.calls),projectName:row.data?(typeof row.data==='string'?JSON.parse(row.data):row.data).name:'未归属项目'})), channels }
  }
  if (action === 'usage.record') {
    const user=requireActor(actor); if(!user.tenantId) throw new Error('当前账号没有 SaaS 工作区')
    const inputTokens=Math.max(0,Number(input.inputTokens)||0),outputTokens=Math.max(0,Number(input.outputTokens)||0),projectId=input.projectId?String(input.projectId):null
    if(projectId) await resolveProjectAccess(pool,user,projectId,'write')
    let channelScope=input.channelScope==='platform'?'platform':'tenant', providerId=input.providerId?String(input.providerId):null
    if(providerId){ const source=await rows<RowDataPacket[]>(pool,`SELECT owner_type FROM ai_providers WHERE id=? AND enabled=1 AND (owner_type='platform' OR owner_id=?)`,[providerId,user.tenantId]); if(source[0]) channelScope=source[0].owner_type }
    await pool.execute('INSERT INTO token_usage (tenant_id,project_id,page_id,user_id,operation,provider,provider_id,model,channel_scope,input_tokens,output_tokens,total_tokens,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[user.tenantId,projectId,input.pageId?String(input.pageId):null,user.userId,String(input.operation||'generation'),String(input.provider||'unknown'),providerId,String(input.model||'unknown'),channelScope,inputTokens,outputTokens,inputTokens+outputTokens,Date.now()]); return {ok:true}
  }
  if (action === 'ops.summary') {
    requireOperator(actor)
    const tenants=await rows<RowDataPacket[]>(pool,`SELECT COUNT(*) tenants,
      (SELECT COUNT(*) FROM users) users,
      (SELECT COUNT(DISTINCT CONCAT(tenant_id,':',COALESCE(family_id,id))) FROM projects) projects,
      (SELECT COUNT(*) FROM projects) iterations,
      (SELECT COUNT(*) FROM pages) pages,
      (SELECT COUNT(*) FROM page_versions) contentVersions,
      (SELECT GREATEST(COUNT(*)-(SELECT COUNT(DISTINCT page_id) FROM page_versions),0) FROM page_versions) modifications,
      (SELECT COALESCE(SUM(total_tokens),0) FROM token_usage) totalTokens FROM tenants`)
    const recent=await rows<RowDataPacket[]>(pool,`SELECT t.id,t.name,t.status,t.created_at createdAt,
      (SELECT COUNT(*) FROM tenant_members tm WHERE tm.tenant_id=t.id) memberCount,
      (SELECT COUNT(DISTINCT COALESCE(p.family_id,p.id)) FROM projects p WHERE p.tenant_id=t.id) projectCount,
      (SELECT COUNT(*) FROM projects p WHERE p.tenant_id=t.id) iterationCount,
      (SELECT COUNT(*) FROM pages pg JOIN projects p ON p.id=pg.project_id WHERE p.tenant_id=t.id) pageCount,
      (SELECT COUNT(*) FROM page_versions pv JOIN pages pg ON pg.id=pv.page_id JOIN projects p ON p.id=pg.project_id WHERE p.tenant_id=t.id) contentVersionCount,
      (SELECT GREATEST(COUNT(*)-COUNT(DISTINCT pv.page_id),0) FROM page_versions pv JOIN pages pg ON pg.id=pv.page_id JOIN projects p ON p.id=pg.project_id WHERE p.tenant_id=t.id) modificationCount,
      (SELECT COALESCE(SUM(tu.total_tokens),0) FROM token_usage tu WHERE tu.tenant_id=t.id) totalTokens,
      (SELECT MAX(u.last_login_at) FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=t.id) lastLoginAt,
      (SELECT u.id FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=t.id AND tm.role='tenant_admin' ORDER BY tm.created_at LIMIT 1) adminUserId,
      (SELECT u.username FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=t.id AND tm.role='tenant_admin' ORDER BY tm.created_at LIMIT 1) adminUsername,
      (SELECT u.email FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=t.id AND tm.role='tenant_admin' ORDER BY tm.created_at LIMIT 1) adminEmail,
      (SELECT u.display_name FROM tenant_members tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=t.id AND tm.role='tenant_admin' ORDER BY tm.created_at LIMIT 1) adminDisplayName
      FROM tenants t ORDER BY t.updated_at DESC`)
    return { totals:tenants[0], tenants:recent }
  }
  if (action === 'ops.ai.providers.list') { requireOperator(actor); const result=await rows<RowDataPacket[]>(pool,`SELECT * FROM ai_providers WHERE owner_type='platform' ORDER BY created_at`); return result.map(providerDto) }
  if (action === 'ops.ai.models.list') {
    requireOperator(actor)
    const poolRows=await rows<RowDataPacket[]>(pool,`SELECT id,provider_preset_id providerPresetId,provider_name providerName,protocol,model FROM ai_model_pool WHERE enabled=1 ORDER BY provider_name,model`)
    const selected=await rows<RowDataPacket[]>(pool,'SELECT model id FROM ai_allowed_models ORDER BY model')
    return { pool:poolRows, selectedIds:selected.map((row)=>String(row.id)), allModelsEnabled:await areAllAiModelsOpen(pool) }
  }
  if (action === 'ops.ai.models.update') {
    const operator=requireOperator(actor), modelIds=[...new Set<string>((input.modelIds??input.models??[]).map((value:unknown)=>String(value).trim()).filter(Boolean))], allModelsEnabled=input.allModelsEnabled===true, now=Date.now(), connection=await pool.getConnection()
    if(modelIds.length){const placeholders=modelIds.map(()=>'?').join(',');const valid=await rows<RowDataPacket[]>(pool,`SELECT id FROM ai_model_pool WHERE enabled=1 AND id IN (${placeholders})`,modelIds);if(valid.length!==modelIds.length)throw new Error('包含模型池中不存在或已停用的模型')}
    try{await connection.beginTransaction();await connection.execute('DELETE FROM ai_allowed_models');for(const id of modelIds)await connection.execute('INSERT INTO ai_allowed_models (model,created_at,updated_at) VALUES (?,?,?)',[id,now,now]);await connection.execute('INSERT INTO platform_settings (setting_key,setting_value,updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=VALUES(updated_at)',[AI_OPEN_ALL_SETTING,allModelsEnabled?'1':'0',now]);await connection.commit()}catch(error){await connection.rollback();throw error}finally{connection.release()}
    await audit(pool,operator,'ops.ai.models.update',{modelIds,allModelsEnabled});return{ok:true}
  }
  if (action === 'ops.ai.providers.upsert') {
    const operator=requireOperator(actor), provider=input.provider??{}, id=required(provider.id,'服务商标识'), existing=await rows<RowDataPacket[]>(pool,`SELECT credential_cipher FROM ai_providers WHERE id=? AND owner_type='platform'`,[id]), apiKey=String(provider.apiKey??'').trim()
    if(!apiKey&&!existing[0]?.credential_cipher) throw new Error('请输入平台通道 API Key')
    const now=Date.now(),cipher=apiKey?encryptCredential(apiKey):existing[0].credential_cipher
    const providerName=required(provider.name,'通道名称'), protocol=provider.protocol==='anthropic'?'anthropic':'openai', models=Array.isArray(provider.models)?provider.models.map(String):[], poolProviderId=provider.presetId||`platform-${id}`
    await pool.execute(`INSERT INTO ai_providers (id,owner_type,owner_id,name,protocol,base_url,credential_cipher,models,preset_id,cors_hint,use_proxy,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),protocol=VALUES(protocol),base_url=VALUES(base_url),credential_cipher=VALUES(credential_cipher),models=VALUES(models),preset_id=VALUES(preset_id),cors_hint=VALUES(cors_hint),enabled=1,updated_at=VALUES(updated_at)`,[id,'platform',null,providerName,protocol,required(provider.baseUrl,'Base URL'),cipher,JSON.stringify(models),provider.presetId||null,provider.corsHint||'unknown',1,1,now,now])
    for(const model of models){const modelId=`${poolProviderId}:${model}`;await pool.execute(`INSERT INTO ai_model_pool (id,provider_preset_id,provider_name,protocol,model,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE provider_name=VALUES(provider_name),protocol=VALUES(protocol),model=VALUES(model),enabled=1,updated_at=VALUES(updated_at)`,[modelId,poolProviderId,providerName,protocol,model,1,now,now])}
    await audit(pool,operator,'ops.ai.provider.upsert',{providerId:id}); return {ok:true}
  }
  if(action==='ops.ai.providers.remove'){const operator=requireOperator(actor),providerId=required(input.providerId,'平台通道');await pool.execute(`DELETE FROM ai_providers WHERE id=? AND owner_type='platform'`,[providerId]);await audit(pool,operator,'ops.ai.provider.remove',{providerId});return{ok:true}}
  if (action === 'ops.tenant.detail') {
    requireOperator(actor)
    const tenantId = required(input.tenantId, 'SaaS 账号')
    const tenant = await rows<RowDataPacket[]>(pool, 'SELECT id,name,status,created_at createdAt FROM tenants WHERE id=?', [tenantId])
    if (!tenant.length) throw Object.assign(new Error('SaaS 账号不存在'), { statusCode: 404 })
    const projects = await rows<RowDataPacket[]>(pool, `SELECT COALESCE(p.family_id,p.id) familyId,
      MAX(JSON_UNQUOTE(JSON_EXTRACT(p.data,'$.name'))) projectName,
      COUNT(DISTINCT p.id) iterationCount,
      GROUP_CONCAT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(p.data,'$.iteration')) ORDER BY p.updated_at SEPARATOR '、') iterations,
      COUNT(DISTINCT pg.id) pageCount, COUNT(DISTINCT pv.id) contentVersionCount,
      GREATEST(COUNT(DISTINCT pv.id)-COUNT(DISTINCT CASE WHEN pv.id IS NOT NULL THEN pg.id END),0) modificationCount,
      COALESCE((SELECT SUM(tu.total_tokens) FROM token_usage tu JOIN projects tp ON tp.id=tu.project_id WHERE tp.tenant_id=? AND COALESCE(tp.family_id,tp.id)=COALESCE(p.family_id,p.id)),0) totalTokens
      FROM projects p LEFT JOIN pages pg ON pg.project_id=p.id LEFT JOIN page_versions pv ON pv.page_id=pg.id
      WHERE p.tenant_id=? GROUP BY COALESCE(p.family_id,p.id) ORDER BY MAX(p.updated_at) DESC`, [tenantId, tenantId])
    const usageByOperation = await rows<RowDataPacket[]>(pool, `SELECT operation,channel_scope channelScope,provider,model,COUNT(*) calls,COALESCE(SUM(input_tokens),0) inputTokens,COALESCE(SUM(output_tokens),0) outputTokens,COALESCE(SUM(total_tokens),0) totalTokens FROM token_usage WHERE tenant_id=? GROUP BY operation,channel_scope,provider,model ORDER BY totalTokens DESC`, [tenantId])
    return { tenant: tenant[0], projects, usageByOperation }
  }
  if (action === 'ops.tenant.create') {
    const operator=requireOperator(actor), name=required(input.name,'SaaS 名称'), email=cleanEmail(input.email), username=validUsername(input.username,email.split('@')[0]), displayName=required(input.displayName,'管理员姓名'), password=required(input.password,'初始密码')
    if(!email.includes('@')) throw new Error('请输入有效邮箱')
    if(password.length<8) throw new Error('初始密码至少 8 位')
    const duplicate=await rows<RowDataPacket[]>(pool,'SELECT email,username FROM users WHERE email=? OR username=?',[email,username]); if(duplicate.length) throw new Error(duplicate[0].email===email?'该邮箱已存在':'该登录账号已存在')
    const tenantId=nanoid(), userId=nanoid(), now=Date.now(), passwordHash=await bcrypt.hash(password,12), connection=await pool.getConnection()
    try{ await connection.beginTransaction(); await connection.execute('INSERT INTO tenants (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)',[tenantId,name,'active',now,now]); await connection.execute('INSERT INTO users (id,username,email,display_name,password_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',[userId,username,email,displayName,passwordHash,'active',now,now]); await connection.execute('INSERT INTO tenant_members (tenant_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)',[tenantId,userId,'tenant_admin',now,now]); await connection.execute('INSERT INTO managed_credentials (user_id,tenant_id,password_cipher,updated_at) VALUES (?,?,?,?)',[userId,tenantId,encryptCredential(password),now]); await connection.commit() }catch(error){await connection.rollback();throw error}finally{connection.release()}
    await audit(pool,operator,'ops.tenant.create',{tenantId,userId,email}); return {tenantId,userId}
  }
  if (action === 'ops.tenant.update') {
    const operator=requireOperator(actor), tenantId=required(input.tenantId,'SaaS 账号'), status=input.status==='suspended'?'suspended':'active', name=required(input.name,'SaaS 名称')
    await pool.execute('UPDATE tenants SET name=?,status=?,updated_at=? WHERE id=?',[name,status,Date.now(),tenantId]); await audit(pool,operator,'ops.tenant.update',{tenantId,name,status}); return {ok:true}
  }
  if (action === 'ops.tenant.resetAdminPassword') {
    const operator = requireOperator(actor), tenantId = required(input.tenantId, '企业'), userId = required(input.userId, '管理员'), password = required(input.password, '临时密码')
    if (password.length < 8) throw new Error('临时密码至少 8 位')
    const admin = await rows<RowDataPacket[]>(pool, 'SELECT 1 FROM tenant_members WHERE tenant_id=? AND user_id=? AND role=?', [tenantId, userId, 'tenant_admin'])
    if (!admin.length) throw Object.assign(new Error('企业管理员不存在'), { statusCode: 404 })
    const passwordHash = await bcrypt.hash(password, 12)
    const now = Date.now()
    await pool.execute('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', [passwordHash, now, userId])
    await pool.execute('INSERT INTO managed_credentials (user_id,tenant_id,password_cipher,updated_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE tenant_id=VALUES(tenant_id),password_cipher=VALUES(password_cipher),updated_at=VALUES(updated_at)', [userId, tenantId, encryptCredential(password), now])
    await audit(pool, operator, 'ops.tenant.admin.password.reset', { tenantId, userId })
    return { ok: true }
  }
  if (action === 'ops.tenant.adminCredential') {
    requireOperator(actor)
    const tenantId = required(input.tenantId, '企业'), userId = required(input.userId, '管理员')
    const credential = await rows<RowDataPacket[]>(pool, 'SELECT mc.password_cipher passwordCipher FROM managed_credentials mc JOIN tenant_members tm ON tm.user_id=mc.user_id AND tm.tenant_id=mc.tenant_id WHERE mc.tenant_id=? AND mc.user_id=? AND tm.role=?', [tenantId, userId, 'tenant_admin'])
    if (!credential.length) throw Object.assign(new Error('该账号暂无可复制密码，请先单独重置一次密码'), { statusCode: 404 })
    return { password: decryptCredential(String(credential[0].passwordCipher)) }
  }
  throw new Error(`未知的 SaaS 操作：${action}`)
}
