import type { Pool, RowDataPacket } from 'mysql2/promise'
import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import type { Actor } from './saasAuth'
import { canWrite, requireActor, resolveProjectAccess } from './saasAuth'

type Input = Record<string, any>
type Entity = Record<string, any>
type ShareAccess = 'public' | 'expiring' | 'tenant'
type ShareScope = 'single' | 'selected' | 'search' | 'iteration' | 'project'

function parse<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8')) as T
  return value as T
}

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode })
}

function validAccess(value: unknown): ShareAccess {
  if (value === 'public' || value === 'expiring' || value === 'tenant') return value
  throw new Error('请选择有效的分享方式')
}

function validScope(value: unknown): ShareScope {
  if (value === 'single' || value === 'selected' || value === 'search' || value === 'iteration' || value === 'project') return value
  throw new Error('请选择有效的分享范围')
}

function summary(row: RowDataPacket) {
  return {
    id: String(row.id),
    code: String(row.short_code),
    projectId: String(row.project_id),
    title: String(row.title),
    access: row.access_mode as ShareAccess,
    scope: row.scope as ShareScope,
    includeAnnotations: !!row.include_annotations,
    expiresAt: row.expires_at == null ? undefined : Number(row.expires_at),
    status: row.status as 'active' | 'revoked',
    viewCount: Number(row.view_count ?? 0),
    createdAt: Number(row.created_at),
  }
}

export async function initializePrototypeShares(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS prototype_shares (
    id VARCHAR(128) PRIMARY KEY, short_code VARCHAR(16) BINARY NOT NULL, tenant_id VARCHAR(128) NOT NULL,
    created_by VARCHAR(128) NOT NULL, project_id VARCHAR(128) NOT NULL, family_id VARCHAR(128) NOT NULL,
    title VARCHAR(512) NOT NULL, access_mode VARCHAR(32) NOT NULL, scope VARCHAR(32) NOT NULL,
    include_annotations TINYINT(1) NOT NULL DEFAULT 0, selected_page_ids LONGTEXT NULL, permanent_key CHAR(64) NULL,
    expires_at BIGINT NULL, status VARCHAR(32) NOT NULL DEFAULT 'active', view_count BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    UNIQUE KEY uk_prototype_share_code (short_code),
    UNIQUE KEY uk_prototype_share_permanent (permanent_key),
    INDEX idx_prototype_share_project (project_id, created_at),
    INDEX idx_prototype_share_family (family_id, created_at),
    INDEX idx_prototype_share_expiry (status, expires_at),
    CONSTRAINT fk_prototype_share_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_prototype_share_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_prototype_share_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  const [columns] = await pool.execute<RowDataPacket[]>(`SELECT column_name FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='prototype_shares'`)
  if (!columns.some((row) => row.column_name === 'permanent_key'))
    await pool.query('ALTER TABLE prototype_shares ADD COLUMN permanent_key CHAR(64) NULL AFTER selected_page_ids')
  const [indexes] = await pool.execute<RowDataPacket[]>(`SELECT index_name FROM information_schema.statistics
    WHERE table_schema=DATABASE() AND table_name='prototype_shares' AND index_name='uk_prototype_share_permanent'`)
  if (!indexes.length)
    await pool.query('ALTER TABLE prototype_shares ADD UNIQUE KEY uk_prototype_share_permanent (permanent_key)')
  await pool.query("UPDATE prototype_shares SET expires_at=created_at + 7*24*60*60*1000 WHERE access_mode IN ('public','expiring') AND expires_at IS NULL")
}

async function createShortCode(pool: Pool): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = nanoid(10)
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT 1 FROM prototype_shares WHERE short_code=? LIMIT 1', [code])
    if (!rows.length) return code
  }
  throw new Error('短链接生成失败，请重试')
}

function selectedPageIds(input: Input, scope: ShareScope): string[] {
  if (scope !== 'single' && scope !== 'selected' && scope !== 'search') return []
  const values = Array.isArray(input.pageIds) ? input.pageIds : []
  const ids = [...new Set(values.filter((id): id is string => typeof id === 'string' && !!id.trim()))]
  if (scope === 'single' && ids.length !== 1) throw new Error('单页分享请选择一个页面')
  if ((scope === 'selected' || scope === 'search') && !ids.length) throw new Error(scope === 'search' ? '当前搜索没有可分享的页面' : '请选择需要分享的页面')
  if (ids.length > 500) throw new Error('一次最多分享 500 个指定页面')
  return ids.sort()
}

function permanentShareKey(projectId: string, scope: ShareScope, includeAnnotations: boolean, pageIds: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ projectId, scope, includeAnnotations, pageIds: [...pageIds].sort() }))
    .digest('hex')
}

async function liveIteration(pool: Pool, projectRow: RowDataPacket, scope: ShareScope, selectedIds: Set<string>, includeAnnotations: boolean) {
  const project = parse<Entity>(projectRow.data)
  const [pageRows] = await pool.execute<RowDataPacket[]>(`SELECT p.data page_data,v.html
    FROM pages p LEFT JOIN page_versions v ON v.id=p.current_version_id
    WHERE p.project_id=? ORDER BY p.sort_order`, [project.id])
  const values = pageRows.map((row) => ({ page: parse<Entity>(row.page_data), html: row.html == null ? undefined : String(row.html) }))
  const contentIds = new Set<string>()
  if (scope === 'single' || scope === 'selected' || scope === 'search') {
    for (const id of selectedIds) {
      const item = values.find((candidate) => candidate.page.id === id && !candidate.page.spec?.groupOnly && candidate.html)
      if (item) contentIds.add(id)
    }
    if (contentIds.size !== selectedIds.size) throw httpError('部分分享页面已删除或尚无内容，请重新创建分享', 410)
  } else {
    for (const item of values) {
      // Iteration shares are locked by project ID, not by a snapshot of page IDs
      // or by version text in page names. Every resolve therefore picks up the
      // latest set of pages currently belonging to this exact iteration.
      if (!item.page.spec?.groupOnly && item.html)
        contentIds.add(item.page.id)
    }
  }
  const bySpecId = new Map(values.map((item) => [String(item.page.spec?.id), item]))
  const included = new Set(contentIds)
  for (const id of contentIds) {
    let current = values.find((item) => item.page.id === id)
    const seen = new Set<string>()
    while (current?.page.spec?.parentId && !seen.has(current.page.spec.parentId)) {
      seen.add(current.page.spec.parentId)
      const parent = bySpecId.get(String(current.page.spec.parentId))
      if (!parent) break
      included.add(parent.page.id)
      current = parent
    }
  }
  const pages = values
    .filter((item) => included.has(item.page.id))
    .map((item) => ({
      id: item.page.id,
      projectId: item.page.projectId,
      spec: {
        id: item.page.spec.id,
        name: item.page.spec.name,
        parentId: item.page.spec.parentId,
        groupOnly: item.page.spec.groupOnly,
      },
      sortOrder: item.page.sortOrder,
      updatedAt: item.page.updatedAt,
      html: contentIds.has(item.page.id) ? item.html : undefined,
      annotationStore: includeAnnotations && contentIds.has(item.page.id) ? item.page.annotationStore : undefined,
    }))
  return {
    project: {
      id: project.id,
      familyId: project.familyId ?? project.id,
      name: project.name,
      iteration: project.iteration ?? 'v1.0',
      platform: project.platform,
      styleSpec: project.styleSpec,
      updatedAt: project.updatedAt,
    },
    pages,
  }
}

async function resolveLiveShare(pool: Pool, row: RowDataPacket, actor: Actor | null) {
  if (row.status !== 'active') throw httpError('分享链接已停用', 410)
  if (row.expires_at != null && Number(row.expires_at) <= Date.now()) throw httpError('分享链接已过期', 410)
  const access = row.access_mode as ShareAccess
  if (access === 'tenant') {
    const member = requireActor(actor)
    if (!member.tenantId || member.tenantId !== row.tenant_id) throw httpError('该分享仅限所属企业或团队成员查看', 403)
  }
  const [sourceRows] = await pool.execute<RowDataPacket[]>('SELECT data FROM projects WHERE id=? AND tenant_id=? LIMIT 1', [row.project_id, row.tenant_id])
  if (!sourceRows[0]) throw httpError('分享的项目已不存在', 410)
  const sourceProject = parse<Entity>(sourceRows[0].data)
  if (access === 'tenant' && actor?.tenantRole === 'reviewer' && sourceProject.hidden) throw httpError('分享的项目不存在', 404)
  const scope = row.scope as ShareScope
  const selectedIds = new Set<string>(row.selected_page_ids ? parse<string[]>(row.selected_page_ids) : [])
  const [projectRows] = scope === 'project'
    ? await pool.execute<RowDataPacket[]>('SELECT data,updated_at FROM projects WHERE tenant_id=? AND family_id=? ORDER BY updated_at,id', [row.tenant_id, row.family_id])
    : await pool.execute<RowDataPacket[]>('SELECT data,updated_at FROM projects WHERE id=? AND tenant_id=?', [row.project_id, row.tenant_id])
  const iterations = []
  for (const projectRow of projectRows) {
    const iterationScope = scope === 'project' ? 'iteration' : scope
    const iteration = await liveIteration(pool, projectRow, iterationScope, selectedIds, !!row.include_annotations)
    if (iteration.pages.some((page) => page.html)) iterations.push(iteration)
  }
  if (!iterations.length) throw httpError('分享范围内暂无可查看的页面', 410)
  const revision = Math.max(
    Number(row.updated_at),
    ...iterations.flatMap((iteration) => [iteration.project.updatedAt, ...iteration.pages.map((page) => page.updatedAt)]),
  )
  return {
    ...summary(row),
    tenantName: actor && actor.tenantId === row.tenant_id ? (actor.tenantName ?? '') : '',
    revision,
    iterations,
  }
}

export async function dispatchPrototypeShare(pool: Pool, action: string, input: Input, actor: Actor | null): Promise<unknown> {
  if (action === 'share.resolve') {
    const code = String(input.code ?? '').trim()
    if (!/^[A-Za-z0-9_-]{6,16}$/.test(code)) throw httpError('分享链接无效', 404)
    const [values] = await pool.execute<RowDataPacket[]>('SELECT * FROM prototype_shares WHERE short_code=? LIMIT 1', [code])
    const row = values[0]
    if (!row) throw httpError('分享链接无效', 404)
    const result = await resolveLiveShare(pool, row, actor)
    if (input.trackView !== false) await pool.execute('UPDATE prototype_shares SET view_count=view_count+1 WHERE id=?', [row.id])
    return result
  }

  const user = requireActor(actor)
  if (action === 'share.create') {
    if (!canWrite(user)) throw httpError('审阅者不能创建分享链接', 403)
    const projectId = String(input.projectId ?? '')
    const access = validAccess(input.access)
    const scope = validScope(input.scope)
    const pageIds = selectedPageIds(input, scope)
    const projectAccess = await resolveProjectAccess(pool, user, projectId, 'write')
    const project = projectAccess.data
    if (!project || !user.tenantId) throw httpError('项目不存在', 404)
    if (pageIds.length) {
      const placeholders = pageIds.map(() => '?').join(',')
      const [matches] = await pool.execute<RowDataPacket[]>(`SELECT id FROM pages WHERE project_id=? AND id IN (${placeholders})`, [projectId, ...pageIds])
      if (matches.length !== pageIds.length) throw new Error('部分分享页面不存在，请重新选择')
    }
    if (access === 'public' && input.expiresAt == null) throw new Error('公开分享必须设置有效期，不能永久分享')
    let expiresAt: number | null = null
    if (access === 'public' || access === 'expiring' || input.expiresAt != null) {
      expiresAt = Number(input.expiresAt)
      const now = Date.now()
      if (!Number.isFinite(expiresAt) || expiresAt < now + 5 * 60 * 1000 || expiresAt > now + 366 * 24 * 60 * 60 * 1000)
        throw new Error('限时分享有效期需在 5 分钟到 366 天之间')
    }
    const permanentKey = access === 'tenant' && expiresAt == null
      ? permanentShareKey(projectId, scope, !!input.includeAnnotations, pageIds)
      : null
    if (permanentKey) {
      const [existing] = await pool.execute<RowDataPacket[]>("SELECT * FROM prototype_shares WHERE permanent_key=? AND status='active' LIMIT 1", [permanentKey])
      if (existing[0]) return summary(existing[0])
    }
    const now = Date.now(), id = nanoid(), code = await createShortCode(pool)
    const scopeLabel = { single: '单页', selected: '已选页面', search: '当前搜索', iteration: '当前版本号页面', project: '整体项目' }[scope]
    const title = `${project.name} · ${scopeLabel}分享`
    try {
      await pool.execute(`INSERT INTO prototype_shares
        (id,short_code,tenant_id,created_by,project_id,family_id,title,access_mode,scope,include_annotations,selected_page_ids,permanent_key,expires_at,status,view_count,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        id, code, user.tenantId, user.userId, projectId, project.familyId ?? projectId, title, access, scope,
        input.includeAnnotations ? 1 : 0, pageIds.length ? JSON.stringify(pageIds) : null, permanentKey, expiresAt, 'active', 0, now, now,
      ])
    } catch (error) {
      if (permanentKey) {
        const [existing] = await pool.execute<RowDataPacket[]>("SELECT * FROM prototype_shares WHERE permanent_key=? AND status='active' LIMIT 1", [permanentKey])
        if (existing[0]) return summary(existing[0])
      }
      throw error
    }
    const [created] = await pool.execute<RowDataPacket[]>('SELECT * FROM prototype_shares WHERE id=?', [id])
    return summary(created[0]!)
  }
  if (action === 'share.list') {
    const projectId = String(input.projectId ?? '')
    await resolveProjectAccess(pool, user, projectId, 'read')
    const [values] = await pool.execute<RowDataPacket[]>('SELECT * FROM prototype_shares WHERE project_id=? ORDER BY created_at DESC LIMIT 100', [projectId])
    return values.map(summary)
  }
  if (action === 'share.revoke') {
    const projectId = String(input.projectId ?? ''), id = String(input.id ?? '')
    await resolveProjectAccess(pool, user, projectId, 'write')
    const [values] = await pool.execute<RowDataPacket[]>('SELECT created_by FROM prototype_shares WHERE id=? AND project_id=? LIMIT 1', [id, projectId])
    if (!values[0]) throw httpError('分享链接不存在', 404)
    if (values[0].created_by !== user.userId && user.tenantRole !== 'tenant_admin') throw httpError('只能停用自己创建的分享链接', 403)
    await pool.execute("UPDATE prototype_shares SET status='revoked',permanent_key=NULL,updated_at=? WHERE id=?", [Date.now(), id])
    return null
  }
  throw new Error(`未知的分享操作：${action}`)
}

