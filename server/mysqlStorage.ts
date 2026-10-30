import type { IncomingMessage, ServerResponse } from 'node:http'
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import type { Connect, Plugin } from 'vite'
import { nanoid } from 'nanoid'
import { movePageTree } from '../src/utils/pageTree'
import type { Page } from '../src/types/page'
import {
  actorFromRequest,
  canWrite,
  dispatchSaas,
  initializeSaas,
  requireActor,
  requireIterationCreator,
  requireOperator,
  requireProjectCreator,
  requireTenantAdmin,
  resolveProjectAccess,
  resolveManagedAiProvider,
  type Actor,
} from './saasAuth'
import { dispatchPrototypeShare, initializePrototypeShares } from './prototypeShares'

type Db = Pool | PoolConnection
// Storage payloads are intentionally schema-flexible JSON documents.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Entity = Record<string, any>
type SqlValue = string | number | bigint | boolean | Date | null | Buffer | Uint8Array

export interface MysqlStorageConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

const MAX_VERSIONS_PER_PAGE = 20

function json(value: unknown): string {
  return JSON.stringify(value)
}

function restorePatch(input: Entity): Entity {
  const patch = { ...input.patch }
  for (const key of input.unset ?? []) {
    if (typeof key !== 'string' || ['id', '__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('不支持的字段更新')
    patch[key] = undefined
  }
  if ('id' in patch) throw new Error('不能修改记录标识')
  return patch
}

function parse<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8')) as T
  return value as T
}

async function rows<T extends RowDataPacket[]>(db: Db, sql: string, values: SqlValue[] = []): Promise<T> {
  const [result] = await db.execute<T>(sql, values)
  return result
}

async function entity(db: Db, table: string, id: string, lock = false): Promise<Entity | undefined> {
  const result = await rows<RowDataPacket[]>(db, `SELECT data FROM \`${table}\` WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id])
  return result[0] ? parse<Entity>(result[0].data) : undefined
}

async function project(db: Db, id: string, lock = false) { return entity(db, 'projects', id, lock) }
async function page(db: Db, id: string, lock = false) { return entity(db, 'pages', id, lock) }
async function version(db: Db, id: string) { return entity(db, 'page_versions', id) }

async function putProject(db: Db, value: Entity, replace = false) {
  const sql = replace
    ? 'INSERT INTO projects (id, tenant_id, created_by, family_id, updated_at, data) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE tenant_id=COALESCE(VALUES(tenant_id),tenant_id), created_by=COALESCE(VALUES(created_by),created_by), family_id=VALUES(family_id), updated_at=VALUES(updated_at), data=VALUES(data)'
    : 'INSERT INTO projects (id, tenant_id, created_by, family_id, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)'
  await db.execute(sql, [value.id, value.tenantId ?? null, value.createdBy ?? null, value.familyId ?? value.id, value.updatedAt, json(value)])
}

async function putPage(db: Db, value: Entity, replace = false) {
  const sql = replace
    ? 'INSERT INTO pages (id, project_id, sort_order, gen_status, current_version_id, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE project_id=VALUES(project_id), sort_order=VALUES(sort_order), gen_status=VALUES(gen_status), current_version_id=VALUES(current_version_id), updated_at=VALUES(updated_at), data=VALUES(data)'
    : 'INSERT INTO pages (id, project_id, sort_order, gen_status, current_version_id, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)'
  await db.execute(sql, [value.id, value.projectId, value.sortOrder, value.genStatus, value.currentVersionId ?? null, value.updatedAt, json(value)])
}

async function putVersion(db: Db, value: Entity, replace = false) {
  const sql = replace
    ? 'INSERT INTO page_versions (id, page_id, version_number, source, created_at, html, data) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE page_id=VALUES(page_id), version_number=VALUES(version_number), source=VALUES(source), created_at=VALUES(created_at), html=VALUES(html), data=VALUES(data)'
    : 'INSERT INTO page_versions (id, page_id, version_number, source, created_at, html, data) VALUES (?, ?, ?, ?, ?, ?, ?)'
  const metadata = { ...value }
  delete metadata.html
  await db.execute(sql, [value.id, value.pageId, value.versionNumber, value.source, value.createdAt, value.html, json(metadata)])
}

async function getVersions(db: Db, pageId: string, descending = false): Promise<Entity[]> {
  const result = await rows<RowDataPacket[]>(db, `SELECT data, html FROM page_versions WHERE page_id = ? ORDER BY version_number ${descending ? 'DESC' : 'ASC'}`, [pageId])
  return result.map((row) => ({ ...parse<Entity>(row.data), html: row.html }))
}

async function firstExistingId(db: Db, table: string, ids: string[]): Promise<string | undefined> {
  if (!ids.length) return undefined
  const placeholders = ids.map(() => '?').join(',')
  const result = await rows<RowDataPacket[]>(db, `SELECT id FROM \`${table}\` WHERE id IN (${placeholders}) LIMIT 1`, ids)
  return result[0]?.id as string | undefined
}

async function updateProject(db: Db, id: string, patch: Entity, touch = true): Promise<Entity> {
  const current = await project(db, id, true)
  if (!current) throw new Error('项目不存在，请刷新后重试')
  const next = { ...current, ...patch, id: current.id, familyId: current.familyId, tenantId: current.tenantId, createdBy: current.createdBy, ...(touch ? { updatedAt: Date.now() } : {}) }
  await putProject(db, next, true)
  return next
}

async function updatePage(db: Db, id: string, patch: Entity, touch = true): Promise<Entity> {
  const current = await page(db, id, true)
  if (!current) throw new Error('页面不存在，请刷新后重试')
  const next = { ...current, ...patch, id: current.id, projectId: current.projectId, ...(touch ? { updatedAt: Date.now() } : {}) }
  await putPage(db, next, true)
  return next
}

async function addVersion(db: Db, payload: Entity): Promise<Entity> {
  const currentPage = await page(db, payload.pageId, true)
  if (!currentPage) throw new Error('页面不存在，请刷新后重试')
  const existing = await getVersions(db, payload.pageId)
  const now = Date.now()
  const saved = {
    id: payload.versionId, pageId: payload.pageId,
    versionNumber: (existing.at(-1)?.versionNumber ?? 0) + 1,
    html: payload.html, source: payload.source, feedbackText: payload.feedbackText, createdAt: now,
  }
  await putVersion(db, saved)
  await updatePage(db, payload.pageId, {
    currentVersionId: saved.id, genStatus: 'done', errorMessage: undefined,
    reviewPending: ['generate', 'refine', 'ai-local'].includes(payload.source), updatedAt: now,
  }, false)
  if (existing.length + 1 > MAX_VERSIONS_PER_PAGE) {
    const surplus = existing.slice(0, existing.length + 1 - MAX_VERSIONS_PER_PAGE)
    if (surplus.length) await db.query('DELETE FROM page_versions WHERE id IN (?)', [surplus.map((item) => item.id)])
  }
  return saved
}

async function transaction<T>(pool: Pool, callback: (db: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection()
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await connection.beginTransaction()
    const result = await callback(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function initialize(pool: Pool) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS projects (
      id VARCHAR(128) PRIMARY KEY, family_id VARCHAR(128) NOT NULL, updated_at BIGINT NOT NULL, data LONGTEXT NOT NULL,
      INDEX idx_projects_family (family_id), INDEX idx_projects_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS pages (
      id VARCHAR(128) PRIMARY KEY, project_id VARCHAR(128) NOT NULL, sort_order INT NOT NULL, gen_status VARCHAR(32) NOT NULL,
      current_version_id VARCHAR(128) NULL, updated_at BIGINT NOT NULL, data LONGTEXT NOT NULL,
      INDEX idx_pages_project_sort (project_id, sort_order), INDEX idx_pages_current_version (current_version_id),
      CONSTRAINT fk_pages_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS page_versions (
      id VARCHAR(160) PRIMARY KEY, page_id VARCHAR(128) NOT NULL, version_number INT NOT NULL, source VARCHAR(32) NOT NULL,
      created_at BIGINT NOT NULL, html LONGTEXT NOT NULL, data LONGTEXT NOT NULL,
      UNIQUE KEY uk_page_version (page_id, version_number), INDEX idx_versions_created (created_at),
      CONSTRAINT fk_versions_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS source_docs (
      id VARCHAR(128) PRIMARY KEY, project_id VARCHAR(128) NOT NULL, data LONGTEXT NOT NULL,
      INDEX idx_docs_project (project_id),
      CONSTRAINT fk_docs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS assets (
      id VARCHAR(128) PRIMARY KEY, project_id VARCHAR(128) NOT NULL, doc_id VARCHAR(128) NOT NULL, mime_type VARCHAR(255) NOT NULL,
      origin VARCHAR(32) NOT NULL, asset_blob LONGBLOB NOT NULL, data LONGTEXT NOT NULL,
      INDEX idx_assets_project (project_id), INDEX idx_assets_doc (doc_id),
      CONSTRAINT fk_assets_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      CONSTRAINT fk_assets_doc FOREIGN KEY (doc_id) REFERENCES source_docs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS iteration_tasks (
      id VARCHAR(128) PRIMARY KEY, tenant_id VARCHAR(128) NOT NULL, created_by VARCHAR(128) NOT NULL,
      status VARCHAR(32) NOT NULL, updated_at BIGINT NOT NULL, data LONGTEXT NOT NULL,
      INDEX idx_iteration_tasks_tenant_updated (tenant_id, updated_at),
      INDEX idx_iteration_tasks_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ]
  for (const statement of statements) await pool.query(statement)
  await initializeSaas(pool)
  await initializePrototypeShares(pool)
  const assetDocConstraint = await rows<RowDataPacket[]>(pool, `SELECT 1 FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND table_name = 'assets' AND constraint_name = 'fk_assets_doc'`)
  if (!assetDocConstraint.length) await pool.query('ALTER TABLE assets ADD CONSTRAINT fk_assets_doc FOREIGN KEY (doc_id) REFERENCES source_docs(id) ON DELETE CASCADE')
}

const TENANT_ADMIN_ACTIONS = new Set([
  'project.setHidden', 'project.updateFamily', 'project.removeCascade', 'project.removeFamily',
  'project.importBundle',
])
const WRITE_ACTIONS = new Set([
  'project.update', 'project.updateProfile', 'project.copyIteration', 'project.copyIterations', 'project.saveConstraint', 'project.removeConstraint',
  'iterationTask.create', 'iterationTask.save', 'iterationTask.cancel', 'iterationTask.remove',
  'page.create', 'page.bulkCreate', 'page.update', 'page.saveAnnotationStore', 'page.remove', 'page.resetStale', 'page.saveHierarchy', 'page.rename', 'page.copy',
  'version.add', 'version.initializeHtml', 'version.importLayrr', 'doc.bulkCreate', 'asset.bulkCreate',
])

async function projectIdForAction(db: Db, action: string, input: Entity): Promise<string | undefined> {
  if (['project.get','project.update','project.setHidden','project.removeCascade'].includes(action)) return input.id
  if (action === 'project.importBundle' && input.targetProjectId) return input.targetProjectId
  if (['project.updateProfile','project.saveConstraint','project.removeConstraint','page.listByProject','page.resetStale','page.saveHierarchy','page.copy','version.initializeHtml','version.importLayrr','doc.listByProject','asset.listByProject','workbench.load'].includes(action)) return input.projectId
  if (['project.copyIteration'].includes(action)) return input.sourceId
  if (['project.updateFamily','project.removeFamily'].includes(action)) {
    const result=await rows<RowDataPacket[]>(db,'SELECT id FROM projects WHERE family_id=? LIMIT 1',[input.familyId]); return result[0]?.id as string|undefined
  }
  if (['page.get','page.update','page.saveAnnotationStore','page.remove','page.rename'].includes(action)) {
    const result=await rows<RowDataPacket[]>(db,'SELECT project_id FROM pages WHERE id=?',[input.id]); return result[0]?.project_id as string|undefined
  }
  if (action === 'page.create') return input.page?.projectId
  if (action === 'page.bulkCreate') return input.pages?.[0]?.projectId
  if (['version.listByPage','version.add'].includes(action)) { const result=await rows<RowDataPacket[]>(db,'SELECT project_id FROM pages WHERE id=?',[input.pageId]); return result[0]?.project_id as string|undefined }
  if (action === 'version.get') { const result=await rows<RowDataPacket[]>(db,'SELECT p.project_id FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE v.id=?',[input.id]); return result[0]?.project_id as string|undefined }
  if (action === 'doc.bulkCreate') return input.docs?.[0]?.projectId
  if (action === 'asset.bulkCreate') return input.assets?.[0]?.projectId
  return undefined
}

async function dispatch(pool: Pool, action: string, input: Entity, actor: Actor | null, req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  if (action.startsWith('share.')) return dispatchPrototypeShare(pool, action, input, actor)
  if (action.startsWith('auth.') || action.startsWith('saas.') || action.startsWith('ops.') || action.startsWith('ai.') || action === 'usage.record')
    return dispatchSaas(pool, action, input, req, res, actor)
  if (action === 'health') return { ok: true }
  const user = requireActor(actor)
  if (action === 'project.list') {
    if (!user.tenantId) return []
    const result = await rows<RowDataPacket[]>(pool, `SELECT p.data FROM projects p WHERE p.tenant_id=? AND (
      ?='tenant_admin' OR (EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=?) AND NOT (?='reviewer' AND COALESCE(JSON_EXTRACT(p.data,'$.hidden')=true,false)))
    ) ORDER BY p.updated_at DESC`, [user.tenantId,user.tenantRole ?? '',user.userId,user.tenantRole ?? ''])
    return result.map((row)=>parse(row.data))
  }
  if (action === 'project.listSummaries') {
    if (!user.tenantId) return []
    const result = await rows<RowDataPacket[]>(pool, `SELECT p.data, COUNT(pg.id) pageCount
      FROM projects p LEFT JOIN pages pg ON pg.project_id=p.id
      WHERE p.tenant_id=? AND (
        ?='tenant_admin' OR (EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=?) AND NOT (?='reviewer' AND COALESCE(JSON_EXTRACT(p.data,'$.hidden')=true,false)))
      ) GROUP BY p.id,p.data,p.updated_at ORDER BY p.updated_at DESC`, [user.tenantId,user.tenantRole ?? '',user.userId,user.tenantRole ?? ''])
    return result.map((row) => {
      const item = parse<Entity>(row.data)
      return {
        id: item.id,
        familyId: item.familyId,
        iteration: item.iteration,
        basedOnId: item.basedOnId,
        name: item.name,
        endpointProfile: item.endpointProfile,
        hidden: item.hidden,
        platform: item.platform,
        styleSpec: item.styleSpec,
        modelOverride: item.modelOverride,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        pageCount: Number(row.pageCount),
      }
    })
  }
  if (action === 'project.pageCounts') {
    if (!user.tenantId) return []
    const result = await rows<RowDataPacket[]>(pool, `SELECT p.id projectId, COUNT(pg.id) pageCount
      FROM projects p LEFT JOIN pages pg ON pg.project_id=p.id
      WHERE p.tenant_id=? AND (
        ?='tenant_admin' OR (EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=?) AND NOT (?='reviewer' AND COALESCE(JSON_EXTRACT(p.data,'$.hidden')=true,false)))
      ) GROUP BY p.id`, [user.tenantId,user.tenantRole ?? '',user.userId,user.tenantRole ?? ''])
    return result.map((row) => ({ projectId: String(row.projectId), count: Number(row.pageCount) }))
  }
  if (action === 'project.create' || action === 'project.createBundle') {
    const creator = requireProjectCreator(user)
    const incoming = action === 'project.create' ? input.project : action === 'project.createBundle' ? input.project : input.project
    input = { ...input, project: { ...incoming, tenantId: creator.tenantId, createdBy: creator.userId } }
  } else if (action === 'legacy.importProject' || action === 'project.importBundle') {
    const admin = requireTenantAdmin(user)
    input = { ...input, project: { ...input.project, tenantId: admin.tenantId, createdBy: admin.userId } }
  } else {
    if (action.startsWith('iterationTask.')) {
      requireIterationCreator(user)
      const task = action === 'iterationTask.create'
        ? input.task
        : action === 'iterationTask.save'
          ? input.task
          : action === 'iterationTask.cancel' || action === 'iterationTask.remove'
            ? await entity(pool, 'iteration_tasks', input.id)
            : undefined
      if (task) {
        if (task.tenantId && task.tenantId !== user.tenantId) throw Object.assign(new Error('无权访问该迭代任务'), { statusCode: 403 })
        for (const endpoint of task.endpoints ?? []) {
          if (!endpoint?.sourceProjectId) continue
          await resolveProjectAccess(pool, user, endpoint.sourceProjectId, 'write')
          if (action === 'iterationTask.create') {
            const sourceProject = await project(pool, endpoint.sourceProjectId)
            if (sourceProject?.hidden)
              throw Object.assign(new Error('隐藏项目不能加入多端迭代任务'), { statusCode: 400 })
          }
        }
      }
    } else if (action === 'project.copyIteration' || action === 'project.copyIterations') requireIterationCreator(user)
    else if (TENANT_ADMIN_ACTIONS.has(action)) requireTenantAdmin(user)
    if (action === 'project.copyIterations') {
      if (!Array.isArray(input.requests) || !input.requests.length || input.requests.length > 8) throw new Error('请选择 1–8 个需要同步迭代的端')
      for (const request of input.requests) {
        if (!request?.sourceId) throw new Error('同步迭代来源版本无效')
        await resolveProjectAccess(pool, user, request.sourceId, 'write')
      }
    }
    const projectId = await projectIdForAction(pool, action, input)
    if (projectId) await resolveProjectAccess(pool, user, projectId, WRITE_ACTIONS.has(action) || TENANT_ADMIN_ACTIONS.has(action) ? 'write' : 'read')
    else if (WRITE_ACTIONS.has(action) && !canWrite(user)) throw Object.assign(new Error('审阅者仅可查看原型，不能编辑'), { statusCode: 403 })
    if (projectId && action === 'page.bulkCreate' && (input.pages ?? []).some((item: Entity) => item.projectId !== projectId)) throw new Error('页面数据归属不一致')
    if (projectId && action === 'doc.bulkCreate' && (input.docs ?? []).some((item: Entity) => item.projectId !== projectId)) throw new Error('文档数据归属不一致')
    if (projectId && action === 'asset.bulkCreate' && (input.assets ?? []).some((item: Entity) => item.projectId !== projectId)) throw new Error('资产数据归属不一致')
    if (action === 'project.update' && user.tenantRole !== 'tenant_admin') {
      const patch = restorePatch(input)
      if ('hidden' in patch || 'name' in patch || 'familyId' in patch || 'tenantId' in patch || 'createdBy' in patch) throw Object.assign(new Error('仅管理员可修改项目基础信息'), { statusCode: 403 })
    }
  }
  switch (action) {
    case 'usage': {
      const result = await rows<RowDataPacket[]>(pool, `SELECT COALESCE(SUM(data_length + index_length), 0) usage FROM information_schema.tables WHERE table_schema = DATABASE()`)
      return { usage: Number(result[0]?.usage ?? 0), quota: 0 }
    }
    case 'project.get': return project(pool, input.id)
    case 'iterationTask.list': {
      const result = await rows<RowDataPacket[]>(pool, 'SELECT data FROM iteration_tasks WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 50', [user.tenantId!])
      const tasks = result.map((row) => parse<Entity>(row.data))
      if (user.tenantRole === 'tenant_admin') return tasks
      const accessible: Entity[] = []
      for (const task of tasks) {
        try {
          for (const endpoint of task.endpoints ?? [])
            await resolveProjectAccess(pool, user, endpoint.sourceProjectId, 'write')
          accessible.push(task)
        } catch {
          // A task is visible only when every participating project is still writable.
        }
      }
      return accessible
    }
    case 'iterationTask.listSummaries': {
      const result = await rows<RowDataPacket[]>(pool, 'SELECT data FROM iteration_tasks WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 50', [user.tenantId!])
      let tasks = result.map((row) => parse<Entity>(row.data))
      if (user.tenantRole !== 'tenant_admin') {
        if (user.tenantRole !== 'designer') return []
        const assignedRows = await rows<RowDataPacket[]>(pool, `SELECT pm.project_id projectId FROM project_members pm
          JOIN projects p ON p.id=pm.project_id WHERE pm.user_id=? AND p.tenant_id=?`, [user.userId, user.tenantId!])
        const assigned = new Set(assignedRows.map((row) => String(row.projectId)))
        tasks = tasks.filter((task) => (task.endpoints ?? []).every((endpoint: Entity) => assigned.has(String(endpoint.sourceProjectId))))
      }
      return tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        primarySourceId: task.primarySourceId,
        requirementText: '',
        documents: [],
        images: [],
        endpoints: (task.endpoints ?? []).map((endpoint: Entity) => ({
          sourceProjectId: endpoint.sourceProjectId,
          sourceFamilyId: endpoint.sourceFamilyId,
          projectName: endpoint.projectName,
          sourceIteration: endpoint.sourceIteration,
          targetIteration: endpoint.targetIteration,
          generationProviderId: endpoint.generationProviderId,
          generationModel: endpoint.generationModel,
          status: endpoint.status,
          targetProjectId: endpoint.targetProjectId,
          completedPages: endpoint.completedPages,
          totalPages: endpoint.totalPages,
          error: endpoint.error,
          aiSession: endpoint.aiSession ? { ...endpoint.aiSession, system: '', messages: [] } : undefined,
        })),
        cancelledAt: task.cancelledAt,
        cancelMode: task.cancelMode,
        error: task.error,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      }))
    }
    case 'iterationTask.create': return transaction(pool, async (db) => {
      const now = Date.now()
      const value: Entity = {
        ...input.task,
        id: String(input.task?.id || nanoid()),
        tenantId: user.tenantId,
        createdBy: user.userId,
        status: ['pending', 'running', 'failed', 'completed', 'cancelled'].includes(input.task?.status) ? input.task.status : 'pending',
        createdAt: Number(input.task?.createdAt) || now,
        updatedAt: now,
      }
      if (!Array.isArray(value.endpoints) || !value.endpoints.length || value.endpoints.length > 8) throw new Error('迭代任务必须包含 1–8 个端')
      await db.execute('INSERT INTO iteration_tasks (id,tenant_id,created_by,status,updated_at,data) VALUES (?,?,?,?,?,?)', [value.id,user.tenantId!,user.userId,value.status,value.updatedAt,json(value)])
      return value
    })
    case 'iterationTask.save': return transaction(pool, async (db) => {
      const current = await entity(db, 'iteration_tasks', input.task?.id, true)
      if (!current || current.tenantId !== user.tenantId) throw new Error('迭代任务不存在')
      if (current.status === 'cancelled') throw new Error('迭代任务已撤销，不能继续写入')
      const now = Date.now()
      const value = {
        ...input.task,
        id: current.id,
        tenantId: current.tenantId,
        createdBy: current.createdBy,
        createdAt: current.createdAt,
        updatedAt: now,
      }
      if (!Array.isArray(value.endpoints) || !value.endpoints.length || value.endpoints.length > 8) throw new Error('迭代任务数据无效')
      await db.execute('UPDATE iteration_tasks SET status=?,updated_at=?,data=? WHERE id=?', [value.status,value.updatedAt,json(value),value.id])
      return value
    })
    case 'iterationTask.cancel': return transaction(pool, async (db) => {
      const current = await entity(db, 'iteration_tasks', input.id, true)
      if (!current || current.tenantId !== user.tenantId) throw new Error('迭代任务不存在')
      if (current.status === 'completed') throw new Error('已完成任务不能撤销')
      const targetIds: string[] = []
      for (const endpoint of current.endpoints ?? []) {
        if (!endpoint.targetProjectId) continue
        const target = await project(db, endpoint.targetProjectId, true)
        if (!target || target.tenantId !== user.tenantId) throw new Error('任务目标版本不存在或无权访问')
        if (
          target.id === endpoint.sourceProjectId ||
          target.basedOnId !== endpoint.sourceProjectId ||
          (target.familyId ?? target.id) !== endpoint.sourceFamilyId ||
          String(target.iteration ?? 'v1.0').toLowerCase() !== String(endpoint.targetIteration).toLowerCase()
        ) throw new Error('任务目标版本归属校验失败，已停止删除')
        await resolveProjectAccess(db, user, target.id, 'write')
        targetIds.push(target.id)
      }
      const uniqueTargetIds = [...new Set(targetIds)]
      if (input.deleteVersions && uniqueTargetIds.length) {
        const placeholders = uniqueTargetIds.map(() => '?').join(',')
        await db.execute(`DELETE FROM projects WHERE id IN (${placeholders}) AND tenant_id=?`, [...uniqueTargetIds,user.tenantId!])
      }
      const now = Date.now()
      const value: Entity = {
        ...current,
        status: 'cancelled',
        cancelMode: input.deleteVersions ? 'delete-versions' : 'keep-versions',
        cancelledAt: now,
        updatedAt: now,
        error: undefined,
      }
      await db.execute('UPDATE iteration_tasks SET status=?,updated_at=?,data=? WHERE id=?', [value.status,now,json(value),value.id])
      return value
    })
    case 'iterationTask.remove': await pool.execute('DELETE FROM iteration_tasks WHERE id=? AND tenant_id=?', [input.id,user.tenantId!]); return null
    case 'project.create': return transaction(pool, async (db) => {
      const value = { ...input.project, familyId: input.project.familyId ?? input.project.id, iteration: input.project.iteration ?? 'v1.0' }
      await putProject(db, value)
      if (user.tenantRole === 'designer') await db.execute('INSERT IGNORE INTO project_members (project_id,user_id,created_at) VALUES (?,?,?)', [value.id,user.userId,Date.now()])
      return null
    })
    case 'project.createBundle': return transaction(pool, async (db) => {
      const value = { ...input.project, familyId: input.project.familyId ?? input.project.id, iteration: input.project.iteration ?? 'v1.0' }
      await putProject(db, value)
      if (user.tenantRole === 'designer') await db.execute('INSERT IGNORE INTO project_members (project_id,user_id,created_at) VALUES (?,?,?)', [value.id,user.userId,Date.now()])
      for (const item of [...(input.pages ?? []), ...(input.docs ?? []), ...(input.assets ?? [])]) {
        if (item.projectId !== value.id) throw new Error('项目数据归属不一致')
      }
      for (const item of input.pages ?? []) await putPage(db, item)
      for (const item of input.docs ?? []) {
        await db.execute('INSERT INTO source_docs (id, project_id, data) VALUES (?, ?, ?)', [item.id, item.projectId, json(item)])
      }
      for (const item of input.assets ?? []) {
        const metadata = { ...item }
        delete metadata.blobBase64
        await db.execute(
          'INSERT INTO assets (id, project_id, doc_id, mime_type, origin, asset_blob, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [item.id, item.projectId, item.docId, item.mimeType, item.origin, Buffer.from(item.blobBase64, 'base64'), json(metadata)],
        )
      }
      return null
    })
    case 'project.importBundle': return transaction(pool, async (db) => {
      const incoming = input.project as Entity
      const targetProjectId = typeof input.targetProjectId === 'string' ? input.targetProjectId : undefined
      const pages = (input.pages ?? []) as Entity[]
      const versions = (input.versions ?? []) as Entity[]
      const docs = (input.docs ?? []) as Entity[]
      const assets = (input.assets ?? []) as Entity[]
      let value: Entity
      if (targetProjectId) {
        const current = await project(db, targetProjectId, true)
        if (!current || current.tenantId !== incoming.tenantId) throw new Error('目标空项目不存在或无权访问')
        const counts = await rows<RowDataPacket[]>(db, 'SELECT COUNT(*) count FROM pages WHERE project_id = ?', [targetProjectId])
        if (Number(counts[0]?.count ?? 0) > 0) throw new Error('仅空项目可以导入完整项目包')
        value = {
          ...current,
          platform: incoming.platform,
          styleSpec: incoming.styleSpec,
          analysis: incoming.analysis,
          generationConstraints: incoming.generationConstraints,
          modelOverride: incoming.modelOverride,
          updatedAt: Date.now(),
        }
        await putProject(db, value, true)
      } else {
        value = {
          ...incoming,
          familyId: incoming.id,
          iteration: 'v1.0',
          basedOnId: undefined,
          hidden: false,
          updatedAt: Date.now(),
        }
        await putProject(db, value)
      }
      for (const item of [...pages, ...docs, ...assets])
        if (item.projectId !== value.id) throw new Error('项目包数据归属不一致')
      const pageIds = new Set(pages.map((item) => item.id))
      const versionIds = new Set(versions.map((item) => item.id))
      const docIds = new Set(docs.map((item) => item.id))
      for (const item of versions)
        if (!pageIds.has(item.pageId)) throw new Error('项目包存在无法归属的页面版本')
      for (const item of pages)
        if (item.currentVersionId && !versionIds.has(item.currentVersionId)) throw new Error('项目包的当前版本数据不完整')
      for (const item of assets)
        if (!docIds.has(item.docId)) throw new Error('项目包存在无法归属的图片资产')
      for (const [table, ids] of [
        ['pages', [...pageIds]], ['page_versions', [...versionIds]],
        ['source_docs', [...docIds]], ['assets', assets.map((item) => item.id)],
      ] as const) {
        const duplicate = await firstExistingId(db, table, [...ids] as string[])
        if (duplicate) throw new Error('项目包记录 ID ' + duplicate + ' 已存在')
      }
      for (const item of pages) await putPage(db, item)
      for (const item of versions) await putVersion(db, item)
      for (const item of docs)
        await db.execute('INSERT INTO source_docs (id, project_id, data) VALUES (?, ?, ?)', [item.id, item.projectId, json(item)])
      for (const item of assets) {
        const metadata = { ...item }
        delete metadata.blobBase64
        await db.execute(
          'INSERT INTO assets (id, project_id, doc_id, mime_type, origin, asset_blob, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [item.id, item.projectId, item.docId, item.mimeType, item.origin, Buffer.from(item.blobBase64, 'base64'), json(metadata)],
        )
      }
      return { projectId: value.id }
    })
    case 'legacy.importProject': return transaction(pool, async (db) => {
      const incoming = input.project as Entity
      if (!incoming?.id) throw new Error('旧项目缺少项目 ID，无法迁移')
      if (await project(db, incoming.id, true)) return { status: 'skipped', projectId: incoming.id }
      const value: Entity = { ...incoming, familyId: incoming.familyId ?? incoming.id, iteration: incoming.iteration ?? 'v1.0', tenantId: input.project.tenantId, createdBy: input.project.createdBy }
      const pages = (input.pages ?? []) as Entity[]
      const versions = (input.versions ?? []) as Entity[]
      const docs = (input.docs ?? []) as Entity[]
      const assets = (input.assets ?? []) as Entity[]
      for (const item of [...pages, ...docs, ...assets]) if (item.projectId !== value.id) throw new Error(`旧项目「${value.name ?? value.id}」的数据归属不一致`)
      const pageIds = new Set(pages.map((item) => item.id))
      const versionIds = new Set(versions.map((item) => item.id))
      const docIds = new Set(docs.map((item) => item.id))
      for (const item of versions) if (!pageIds.has(item.pageId)) throw new Error(`旧项目「${value.name ?? value.id}」存在无法归属的页面版本`)
      for (const item of pages) if (item.currentVersionId && !versionIds.has(item.currentVersionId)) throw new Error(`旧项目「${value.name ?? value.id}」的当前版本数据不完整`)
      for (const item of assets) if (!docIds.has(item.docId)) throw new Error(`旧项目「${value.name ?? value.id}」存在无法归属的图片资产`)
      for (const [table, ids] of [
        ['pages', [...pageIds]], ['page_versions', [...versionIds]],
        ['source_docs', [...docIds]], ['assets', assets.map((item) => item.id)],
      ] as const) {
        const duplicate = await firstExistingId(db, table, [...ids] as string[])
        if (duplicate) throw new Error(`记录 ID ${duplicate} 已存在，请先处理 MySQL 中的冲突数据`)
      }
      await putProject(db, value)
      for (const item of pages) await putPage(db, item)
      for (const item of versions) await putVersion(db, item)
      for (const item of docs) await db.execute('INSERT INTO source_docs (id, project_id, data) VALUES (?, ?, ?)', [item.id, item.projectId, json(item)])
      for (const item of assets) {
        const metadata = { ...item }
        delete metadata.blobBase64
        await db.execute(
          'INSERT INTO assets (id, project_id, doc_id, mime_type, origin, asset_blob, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [item.id, item.projectId, item.docId, item.mimeType, item.origin, Buffer.from(item.blobBase64, 'base64'), json(metadata)],
        )
      }
      return { status: 'imported', projectId: value.id, pages: pages.length, versions: versions.length, docs: docs.length, assets: assets.length }
    })
    case 'project.update': return transaction(pool, async (db) => {
      await updateProject(db, input.id, restorePatch(input)); return null
    })
    case 'project.setHidden': return transaction(pool, async (db) => {
      await updateProject(db, input.id, { hidden: input.hidden }, false); return null
    })
    case 'project.updateFamily': return transaction(pool, async (db) => {
      const result = await rows<RowDataPacket[]>(db, 'SELECT data FROM projects WHERE family_id = ? AND tenant_id = ? ORDER BY id FOR UPDATE', [input.familyId, user.tenantId!])
      for (const row of result) { const value = { ...parse<Entity>(row.data), ...input.patch }; await putProject(db, value, true) }
      return null
    })
    case 'project.updateProfile': return transaction(pool, async (db) => {
      const current = await project(db, input.projectId, true)
      if (!current) throw new Error('项目不存在，请刷新后重试')
      const profile = {
        nature: String(input.profile?.nature ?? '').trim().slice(0, 120),
        purpose: String(input.profile?.purpose ?? '').trim().slice(0, 2000),
      }
      if (!profile.nature && !profile.purpose) throw new Error('请填写端性质或项目用途')
      const familyId = current.familyId ?? current.id
      const result = await rows<RowDataPacket[]>(db, 'SELECT data FROM projects WHERE family_id = ? AND tenant_id = ? ORDER BY id FOR UPDATE', [familyId, user.tenantId!])
      for (const row of result) {
        const value = { ...parse<Entity>(row.data), endpointProfile: profile }
        await putProject(db, value, true)
      }
      return profile
    })
    case 'project.removeCascade': await pool.execute('DELETE FROM projects WHERE id = ?', [input.id]); return null
    case 'project.removeFamily': await pool.execute('DELETE FROM projects WHERE family_id = ? AND tenant_id = ?', [input.familyId, user.tenantId!]); return null
    case 'project.saveConstraint': return transaction(pool, async (db) => {
      const current = await project(db, input.projectId, true); if (!current) throw new Error('项目不存在，请重新打开项目')
      const items = [...(current.generationConstraints ?? [])]
      if (items.some((item: Entity) => item.id !== input.item.id && item.name.trim() === input.item.name.trim())) throw new Error('已存在同名全局约束，请使用其他名称')
      const saved = { ...input.item, name: input.item.name.trim(), updatedAt: Date.now() }
      const index = items.findIndex((item: Entity) => item.id === saved.id)
      if (index < 0) items.push(saved); else items[index] = saved
      await updateProject(db, input.projectId, { generationConstraints: items, updatedAt: saved.updatedAt }, false); return items
    })
    case 'project.removeConstraint': return transaction(pool, async (db) => {
      const current = await project(db, input.projectId, true); if (!current) throw new Error('项目不存在，请重新打开项目')
      const items = (current.generationConstraints ?? []).filter((item: Entity) => item.id !== input.id)
      await updateProject(db, input.projectId, { generationConstraints: items }); return items
    })
    case 'project.copyIteration':
    case 'project.copyIterations': return transaction(pool, async (db) => {
      const copyOne = async (copyInput: Entity): Promise<Entity> => {
      const source = await project(db, copyInput.sourceId); if (!source) throw new Error('来源版本不存在')
      const label = copyInput.iteration.trim(); if (!label) throw new Error('请输入版本号')
      const familyId = source.familyId ?? source.id
      const siblings = await rows<RowDataPacket[]>(db, 'SELECT data FROM projects WHERE family_id = ? AND tenant_id = ? ORDER BY id FOR UPDATE', [familyId, user.tenantId!])
      if (siblings.some((row) => parse<Entity>(row.data).iteration?.toLowerCase() === label.toLowerCase())) throw new Error('该版本号已存在')
      const pageRows = await rows<RowDataPacket[]>(db, 'SELECT data FROM pages WHERE project_id = ? ORDER BY sort_order FOR UPDATE', [source.id])
      const pages = pageRows.map((row) => parse<Entity>(row.data))
      if (pages.some((item) => ['queued', 'generating'].includes(item.genStatus))) throw new Error('来源版本仍在生成，请先停止生成或等待完成')
      const now = Date.now()
      const versions = await rows<RowDataPacket[]>(db, 'SELECT data, html FROM page_versions WHERE page_id IN (SELECT id FROM pages WHERE project_id = ?)', [source.id])
      const versionValues: Entity[] = versions.map((row) => ({ ...parse<Entity>(row.data), html: row.html }))
      const docs = await rows<RowDataPacket[]>(db, 'SELECT data FROM source_docs WHERE project_id = ?', [source.id])
      const assets = await rows<RowDataPacket[]>(db, 'SELECT data, asset_blob FROM assets WHERE project_id = ?', [source.id])
      const rawRequirement = copyInput.requirement && typeof copyInput.requirement === 'object' ? copyInput.requirement : undefined
      const requirementText = String(rawRequirement?.text ?? '').trim().slice(0, 200000)
      const requirementDocuments = Array.isArray(rawRequirement?.documents)
        ? rawRequirement.documents.slice(0, 30).map((item: Entity) => ({
            fileName: String(item.fileName ?? '迭代需求').slice(0, 255),
            fileType: ['docx', 'pdf', 'xlsx', 'md', 'txt', 'image'].includes(item.fileType) ? item.fileType : 'txt',
            text: String(item.text ?? '').slice(0, 2 * 1024 * 1024),
            meta: item.meta && typeof item.meta === 'object' ? item.meta : {},
          }))
        : []
      const relatedPages = Array.isArray(rawRequirement?.relatedPages)
        ? rawRequirement.relatedPages.slice(0, 100).map((item: Entity) => ({
            projectId: String(item.projectId ?? ''), projectName: String(item.projectName ?? '').slice(0, 120),
            iteration: String(item.iteration ?? 'v1.0').slice(0, 80), platform: item.platform === 'mobile' ? 'mobile' : 'pc',
            pageId: String(item.pageId ?? ''), pageName: String(item.pageName ?? '').slice(0, 120),
            description: String(item.description ?? '').slice(0, 1200),
            blocks: Array.isArray(item.blocks) ? item.blocks.map((block: unknown) => String(block).slice(0, 240)).slice(0, 16) : [],
          })).filter((item: Entity) => item.projectId && item.pageId)
        : []
      const relatedById = new Map(relatedPages.map((item: Entity) => [item.pageId, item]))
      const productNature = String(rawRequirement?.plan?.productNature ?? '').trim().slice(0, 240)
      const planSummary = String(rawRequirement?.plan?.summary ?? '').trim().slice(0, 2000)
      const planChanges = Array.isArray(rawRequirement?.plan?.changes) ? rawRequirement.plan.changes.slice(0, 40) : []
      const pageById = new Map(pages.map((item) => [item.id, item]))
      const updateBySourceId = new Map<string, Entity>()
      const createChanges: Entity[] = []
      for (const raw of planChanges) {
        if (!raw || (raw.action !== 'update' && raw.action !== 'create')) continue
        const relatedPageIds = Array.isArray(raw.relatedPageIds)
          ? [...new Set<string>(raw.relatedPageIds.map(String).filter((id: string) => relatedById.has(id)))]
          : []
        const change: Entity = {
          action: raw.action,
          sourcePageId: typeof raw.sourcePageId === 'string' ? raw.sourcePageId : undefined,
          parentSourcePageId: typeof raw.parentSourcePageId === 'string' ? raw.parentSourcePageId : undefined,
          name: String(raw.name ?? '').trim().slice(0, 80),
          description: String(raw.description ?? '').trim().slice(0, 1200),
          blocks: Array.isArray(raw.blocks) ? raw.blocks.map((block: unknown) => String(block).trim()).filter(Boolean).slice(0, 16) : [],
          reason: String(raw.reason ?? '根据本次版本需求进行初始迭代').trim().slice(0, 1200),
          relatedPageIds,
        }
        if (change.action === 'update') {
          const sourcePage = change.sourcePageId ? pageById.get(change.sourcePageId) : undefined
          if (sourcePage && !sourcePage.spec.groupOnly && !updateBySourceId.has(sourcePage.id)) updateBySourceId.set(sourcePage.id, change)
        } else if (change.name) createChanges.push(change)
      }
      if (rawRequirement && !requirementText && !requirementDocuments.length) throw new Error('请填写或上传新版本功能需求')
      if (rawRequirement && !updateBySourceId.size && !createChanges.length) throw new Error('AI 未规划出可执行的版本页面变更')
      const pageIds = new Map(pages.map((item) => [item.id, nanoid()]))
      const versionIds = Object.fromEntries(versionValues.map((item) => [item.id, nanoid()]))
      const docIds = Object.fromEntries(docs.map((row) => [parse<Entity>(row.data).id, nanoid()]))
      const remapConstraint = (item: Entity) => ({ ...item, sourcePageId: item.sourcePageId ? pageIds.get(item.sourcePageId) : undefined })
      // PageSpec IDs describe the tree and may differ from database Page IDs.
      // Keep that tree intact; remap only references to database records.
      const copiedPages: Entity[] = pages.map((item) => {
        const change = updateBySourceId.get(item.id)
        return {
          ...item, id: pageIds.get(item.id),
          spec: {
            ...item.spec,
            ...(change ? {
              description: change.description || item.spec.description,
              blocks: change.blocks.length ? change.blocks : item.spec.blocks,
              iterationChange: { action: 'update', reason: change.reason, relatedPageIds: change.relatedPageIds },
            } : {}),
            ...(item.spec.constraints ? { constraints: { ...item.spec.constraints, items: item.spec.constraints.items.map(remapConstraint) } } : {}),
            ...(item.spec.importedPages ? { importedPages: item.spec.importedPages.map((reference: Entity) => ({ ...reference, pageId: pageIds.get(reference.pageId) })).filter((reference: Entity) => !!reference.pageId) } : {}),
          },
          currentVersionId: item.currentVersionId ? versionIds[item.currentVersionId] : undefined,
          ...(change ? { genStatus: 'idle', errorMessage: undefined, iterationInitialized: false } : {}),
          reviewPending: false, updatedAt: now,
        }
      })
      const usedNames = new Set(copiedPages.map((item) => String(item.spec.name).trim().toLowerCase()))
      for (const change of createChanges) {
        const sourceParent = change.parentSourcePageId ? pageById.get(change.parentSourcePageId) : undefined
        const requested = change.name.toLowerCase().includes(label.toLowerCase()) ? change.name : `${change.name} ${label}`
        let name = requested, suffix = 2
        while (usedNames.has(name.toLowerCase())) name = `${requested} ${suffix++}`
        usedNames.add(name.toLowerCase())
        const id = nanoid()
        copiedPages.push({
          id, projectId: '', sortOrder: copiedPages.length, genStatus: 'idle', reviewPending: false,
          iterationInitialized: false, updatedAt: now,
          spec: {
            id: nanoid(), name,
            ...(sourceParent ? { parentId: sourceParent.spec.id } : {}),
            description: change.description, blocks: change.blocks,
            iterationChange: { action: 'create', reason: change.reason, relatedPageIds: change.relatedPageIds },
          },
        })
      }
      const copiedVersionValues = versionValues.map((item) => ({ ...item, id: versionIds[item.id], pageId: pageIds.get(item.pageId) }))
      const baselineVersions: Entity[] = []
      if (rawRequirement) {
        for (const sourcePage of pages) {
          if (!updateBySourceId.has(sourcePage.id) || !sourcePage.currentVersionId) continue
          const current = versionValues.find((item) => item.id === sourcePage.currentVersionId)
          const copiedPage = copiedPages.find((item) => item.id === pageIds.get(sourcePage.id))
          if (!current || !copiedPage) continue
          const baseline = {
            id: nanoid(), pageId: copiedPage.id,
            versionNumber: Math.max(0, ...versionValues.filter((item) => item.pageId === sourcePage.id).map((item) => Number(item.versionNumber) || 0)) + 1,
            html: current.html, source: 'copy', feedbackText: `旧版本 ${source.iteration ?? 'v1.0'} 基线`, createdAt: now,
          }
          baselineVersions.push(baseline)
          copiedPage.currentVersionId = baseline.id
        }
      }
      const iterationRequirement = rawRequirement ? {
        text: requirementText,
        documentNames: requirementDocuments.map((item: Entity) => item.fileName),
        sourceProjectId: source.id,
        sourceIteration: source.iteration ?? 'v1.0',
        productNature,
        relatedPages,
        planSummary,
        createdAt: now,
      } : undefined
      const target: Entity = {
        ...source, id: nanoid(), tenantId: user.tenantId, createdBy: user.userId, familyId, iteration: label, basedOnId: source.id, createdAt: now, updatedAt: now,
        iterationRequirement,
        ...(source.generationConstraints ? { generationConstraints: source.generationConstraints.map(remapConstraint) } : {}),
        ...(source.analysis ? { analysis: { ...source.analysis, pages: copiedPages.map((item) => item.spec) } } : {}),
      }
      await putProject(db, target)
      const assignedUsers = await rows<RowDataPacket[]>(db, `SELECT DISTINCT pm.user_id userId FROM project_members pm JOIN projects p ON p.id=pm.project_id WHERE p.tenant_id=? AND COALESCE(p.family_id,p.id)=?`, [user.tenantId!, familyId])
      for (const member of assignedUsers) await db.execute('INSERT IGNORE INTO project_members (project_id,user_id,created_at) VALUES (?,?,?)', [target.id, member.userId, now])
      for (const item of copiedPages) await putPage(db, { ...item, projectId: target.id })
      for (const item of copiedVersionValues) await putVersion(db, item)
      for (const item of baselineVersions) await putVersion(db, item)
      for (const row of docs) { const item = parse<Entity>(row.data); const saved = { ...item, id: docIds[item.id], projectId: target.id }; await db.execute('INSERT INTO source_docs (id, project_id, data) VALUES (?, ?, ?)', [saved.id, target.id, json(saved)]) }
      for (const item of requirementDocuments) { const saved = { ...item, id: nanoid(), projectId: target.id, meta: { ...item.meta, iterationRequirement: true, iteration: label } }; await db.execute('INSERT INTO source_docs (id, project_id, data) VALUES (?, ?, ?)', [saved.id, target.id, json(saved)]) }
      for (const row of assets) { const item = parse<Entity>(row.data); const saved: Entity = { ...item, id: nanoid(), projectId: target.id, docId: docIds[item.docId] ?? item.docId }; await db.execute('INSERT INTO assets (id, project_id, doc_id, mime_type, origin, asset_blob, data) VALUES (?, ?, ?, ?, ?, ?, ?)', [saved.id, target.id, saved.docId, saved.mimeType, saved.origin, row.asset_blob, json(saved)]) }
      return target
      }
      if (action === 'project.copyIterations') {
        const created: Entity[] = []
        for (const request of input.requests) created.push(await copyOne(request))
        return created
      }
      return copyOne(input)
    })
    case 'page.listByProject': { const result = await rows<RowDataPacket[]>(pool, 'SELECT data FROM pages WHERE project_id = ? ORDER BY sort_order', [input.projectId]); return result.map((row) => parse(row.data)) }
    case 'page.get': return page(pool, input.id)
    case 'page.create': await putPage(pool, input.page); return null
    case 'page.bulkCreate': return transaction(pool, async (db) => { for (const item of input.pages) await putPage(db, item); return null })
    case 'page.update': return transaction(pool, async (db) => { await updatePage(db, input.id, restorePatch(input)); return null })
    case 'page.saveAnnotationStore': return transaction(pool, async (db) => { await updatePage(db, input.id, { annotationStore: input.store }); return input.store })
    case 'page.remove': await pool.execute('DELETE FROM pages WHERE id = ?', [input.id]); return null
    case 'page.resetStale': return transaction(pool, async (db) => {
      const result = await rows<RowDataPacket[]>(db, `SELECT data FROM pages WHERE project_id = ? AND gen_status IN ('generating','queued')`, [input.projectId])
      for (const row of result) { const item = parse<Entity>(row.data); await updatePage(db, item.id, { genStatus: 'failed', errorMessage: '生成被中断，可重试' }) } return null
    })
    case 'page.saveHierarchy': return transaction(pool, async (db) => {
      const currentProject = await project(db, input.projectId, true); if (!currentProject) throw new Error('项目不存在')
      const now = Date.now()
      for (const item of input.pages) { const current = await page(db, item.id); if (!current || current.projectId !== input.projectId) throw new Error('页面已变更，请刷新后重试'); await updatePage(db, item.id, { spec: item.spec, sortOrder: item.sortOrder, updatedAt: now }, false) }
      await updateProject(db, input.projectId, { updatedAt: now, ...(currentProject.analysis ? { analysis: { ...currentProject.analysis, pages: input.pages.map((item: Entity) => item.spec) } } : {}) }, false); return null
    })
    case 'page.rename': return transaction(pool, async (db) => {
      const initial = await page(db, input.id); if (!initial) throw new Error('页面不存在，请刷新后重试')
      const currentProject = await project(db, initial.projectId, true)
      const current = await page(db, input.id, true); if (!current) throw new Error('页面不存在，请刷新后重试')
      const now = Date.now(), spec = { ...current.spec, name: input.name }
      await updatePage(db, input.id, { spec, updatedAt: now }, false)
      if (currentProject?.analysis) await updateProject(db, currentProject.id, { updatedAt: now, analysis: { ...currentProject.analysis, pages: currentProject.analysis.pages.map((item: Entity) => item.id === current.spec.id ? { ...item, name: input.name } : item) } }, false)
      return null
    })
    case 'page.copy': return transaction(pool, async (db) => {
      const currentProject = await project(db, input.projectId, true)
      const source = await page(db, input.pageId, true)
      if (!source || source.projectId !== input.projectId || !currentProject) throw new Error('原页面不存在或不属于当前项目')
      if (source.spec.groupOnly) throw new Error('请选择普通页面进行复制')
      if (['queued', 'generating'].includes(source.genStatus)) throw new Error('原页面正在生成或排队，请停止后再复制')
      const name = input.name?.trim()
      if (!name) throw new Error('页面名不能为空')
      const currentRows = source.currentVersionId
        ? await rows<RowDataPacket[]>(db, 'SELECT data, html FROM page_versions WHERE id = ?', [source.currentVersionId])
        : []
      const current: Entity | undefined = currentRows[0] ? { ...parse<Entity>(currentRows[0].data), html: currentRows[0].html } : undefined
      if (source.currentVersionId && (!current || current.pageId !== source.id)) throw new Error('原页面版本不存在或不匹配，请刷新后重试')
      const now = Date.now(), id = nanoid()
      const savedVersion = current ? { id: nanoid(), pageId: id, versionNumber: 1, html: current.html, source: 'copy', feedbackText: `复制自「${source.spec.name}」`, createdAt: now } : undefined
      const copied: Page = { id, projectId: input.projectId, spec: { ...source.spec, id, name, blocks: [...source.spec.blocks] }, sortOrder: 0, genStatus: savedVersion ? 'done' : 'idle', currentVersionId: savedVersion?.id, reviewPending: false, updatedAt: now }
      const existingRows = await rows<RowDataPacket[]>(db, 'SELECT data FROM pages WHERE project_id = ? ORDER BY sort_order FOR UPDATE', [input.projectId])
      const ordered = movePageTree([...existingRows.map((row) => parse<Page>(row.data)), copied], id, source.id, 'after')
      const savedPage = ordered.find((item) => item.id === id)!
      await putPage(db, savedPage)
      if (savedVersion) await putVersion(db, savedVersion)
      for (const item of ordered) if (item.id !== id) await updatePage(db, item.id, { sortOrder: item.sortOrder }, false)
      await updateProject(db, input.projectId, { updatedAt: now, ...(currentProject.analysis ? { analysis: { ...currentProject.analysis, pages: ordered.map((item) => item.spec) } } : {}) }, false)
      return { page: savedPage, pages: ordered, version: savedVersion, updatedAt: now }
    })
    case 'version.listByPage': return getVersions(pool, input.pageId, true)
    case 'version.get': { const value = await version(pool, input.id); if (!value) return undefined; const result = await rows<RowDataPacket[]>(pool, 'SELECT html FROM page_versions WHERE id = ?', [input.id]); return { ...value, html: result[0].html } }
    case 'version.add': return transaction(pool, (db) => addVersion(db, input))
    case 'version.initializeHtml': return transaction(pool, async (db) => {
      const current = await page(db, input.pageId, true); if (!current || current.projectId !== input.projectId) throw new Error('页面不存在或不属于当前迭代')
      if (current.spec.groupOnly) throw new Error('导航分组不能导入 HTML，请先改为普通页面')
      if (['queued','generating'].includes(current.genStatus)) throw new Error('页面正在生成或排队，请先停止')
      const count = await rows<RowDataPacket[]>(db, 'SELECT COUNT(*) count FROM page_versions WHERE page_id = ?', [input.pageId])
      if (current.currentVersionId || Number(count[0].count)) throw new Error('页面已有内容，不能通过初始化导入覆盖')
      return addVersion(db, input)
    })
    case 'version.importLayrr': return transaction(pool, async (db) => {
      const current = await page(db, input.pageId, true); if (!current || current.projectId !== input.projectId || current.spec.groupOnly) throw new Error('原页面已删除或不属于此迭代')
      const importedRows = input.versionId
        ? await rows<RowDataPacket[]>(db, 'SELECT data, html FROM page_versions WHERE id = ?', [input.versionId])
        : []
      if (importedRows[0]) {
        const complete: Entity = { ...parse<Entity>(importedRows[0].data), html: importedRows[0].html }
        if (complete.pageId !== input.pageId || complete.html !== input.html || complete.feedbackText !== input.feedbackText || complete.source !== input.source) throw new Error('提交信息与已保存版本不一致')
        return complete
      }
      if (current.currentVersionId !== input.baseline) throw new Error('页面已产生新版本，请重新打开 Layrr，避免覆盖其他修改')
      if (['queued','generating'].includes(current.genStatus)) throw new Error('页面仍在生成，请停止后再保存')
      const originalResult = await rows<RowDataPacket[]>(db, 'SELECT data, html FROM page_versions WHERE id = ?', [input.baseline])
      if (!originalResult[0] || parse<Entity>(originalResult[0].data).pageId !== input.pageId) throw new Error('原始版本不匹配')
      if (!input.html.trim() || originalResult[0].html === input.html) throw new Error('没有需要保存的修改')
      return addVersion(db, input)
    })
    case 'doc.bulkCreate': return transaction(pool, async (db) => { for (const item of input.docs) await db.execute('INSERT INTO source_docs (id, project_id, data) VALUES (?, ?, ?)', [item.id, item.projectId, json(item)]); return null })
    case 'doc.listByProject': { const result = await rows<RowDataPacket[]>(pool, 'SELECT data FROM source_docs WHERE project_id = ?', [input.projectId]); return result.map((row) => parse(row.data)) }
    case 'asset.bulkCreate': return transaction(pool, async (db) => { for (const item of input.assets) { const metadata = { ...item }; delete metadata.blobBase64; await db.execute('INSERT INTO assets (id, project_id, doc_id, mime_type, origin, asset_blob, data) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.projectId, item.docId, item.mimeType, item.origin, Buffer.from(item.blobBase64, 'base64'), json(metadata)]) } return null })
    case 'asset.listByProject': { const result = await rows<RowDataPacket[]>(pool, 'SELECT data, asset_blob FROM assets WHERE project_id = ?', [input.projectId]); return result.map((row) => ({ ...parse<Entity>(row.data), blobBase64: Buffer.from(row.asset_blob).toString('base64') })) }
    case 'workbench.load': return transaction(pool, async (db) => {
      const currentProject = await project(db, input.projectId); if (!currentProject) return null
      const staleRows = await rows<RowDataPacket[]>(db, `SELECT data FROM pages WHERE project_id = ? AND gen_status IN ('generating','queued')`, [input.projectId])
      for (const row of staleRows) {
        const item = parse<Entity>(row.data)
        await updatePage(db, item.id, { genStatus: 'failed', errorMessage: '生成被中断，可重试' })
      }
      const pageRows = await rows<RowDataPacket[]>(db, 'SELECT data FROM pages WHERE project_id = ? ORDER BY sort_order', [input.projectId])
      const pages = pageRows.map((row) => parse<Entity>(row.data)), htmlByPage: Record<string, string> = {}
      for (const item of pages) if (item.currentVersionId) { const result = await rows<RowDataPacket[]>(db, 'SELECT html FROM page_versions WHERE id = ?', [item.currentVersionId]); if (result[0]) htmlByPage[item.id] = result[0].html }
      return { project: currentProject, pages, htmlByPage }
    })
    default: throw new Error(`未知的存储操作：${action}`)
  }
}

async function readRequest(req: IncomingMessage): Promise<Entity> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > 512 * 1024 * 1024) throw new Error('单个项目迁移内容不能超过 512 MB，请减少图片资产后重试')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式错误')
  return body as Entity
}

export function mysqlStoragePlugin(config: MysqlStorageConfig): Plugin {
  const pool = mysql.createPool({ ...config, connectionLimit: 10, supportBigNumbers: true, charset: 'utf8mb4' })
  let ready: Promise<void> | undefined
  const start = () => ready ??= initialize(pool)
  const handle = async (req: Connect.IncomingMessage, res: ServerResponse) => {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
      res.statusCode = 403
      res.end(JSON.stringify({ ok: false, error: '不允许跨站存储请求' }))
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end(JSON.stringify({ ok: false, error: '仅支持 POST 请求' }))
      return
    }
    try {
      await start()
      const body = await readRequest(req)
      if (typeof body.action !== 'string' || (body.input != null && (typeof body.input !== 'object' || Array.isArray(body.input)))) throw new Error('请求格式错误')
      const actor = await actorFromRequest(pool, req)
      const result = await dispatch(pool, body.action, body.input ?? {}, actor, req, res)
      res.end(JSON.stringify({ ok: true, result }))
    } catch (error) {
      res.statusCode = Number((error as { statusCode?: number })?.statusCode ?? 500)
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '数据库操作失败' }))
    }
  }
  const handleAi = async (req: Connect.IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'POST') { res.statusCode=405; res.end(); return }
    try {
      await start()
      const actor=await actorFromRequest(pool,req)
      const requestPath=(req.url??'/').replace(/^\/api\/ai(?=\/)/,'')
      const match=requestPath.match(/^\/([^/]+)(\/.*)$/)
      if(!match) throw Object.assign(new Error('AI 通道请求地址无效'),{statusCode:400})
      const provider=await resolveManagedAiProvider(pool,actor,decodeURIComponent(match[1]!))
      const upstreamUrl=provider.baseUrl.replace(/\/+$/,'')+match[2]
      const headers:Record<string,string>={'content-type':String(req.headers['content-type']||'application/json')}
      if(provider.protocol==='anthropic'){headers['x-api-key']=provider.apiKey;headers['anthropic-version']=String(req.headers['anthropic-version']||'2023-06-01')}else headers.authorization=`Bearer ${provider.apiKey}`
      const body=req.method==='POST'?Buffer.from(JSON.stringify(await readRequest(req))):undefined
      const upstream=await fetch(upstreamUrl,{method:req.method,headers,body:body?new Uint8Array(body):undefined})
      res.statusCode=upstream.status
      upstream.headers.forEach((value,key)=>{if(!['content-length','content-encoding','transfer-encoding','connection'].includes(key.toLowerCase()))res.setHeader(key,value)})
      if(!upstream.body){res.end();return}
      const reader=upstream.body.getReader();for(;;){const{done,value}=await reader.read();if(done)break;res.write(value)}res.end()
    } catch(error) {
      res.statusCode=Number((error as {statusCode?:number})?.statusCode??502)
      res.setHeader('content-type','application/json; charset=utf-8')
      res.end(JSON.stringify({error:{message:error instanceof Error?error.message:'平台 AI 通道调用失败'}}))
    }
  }
  return {
    name: 'quickpage-mysql-storage',
    async configureServer(server) {
      await start()
      server.middlewares.use('/api/storage', handle)
      server.middlewares.use('/api/ai', handleAi)
      server.httpServer?.once('close', () => { void pool.end() })
    },
    async configurePreviewServer(server) {
      await start()
      server.middlewares.use('/api/storage', handle)
      server.middlewares.use('/api/ai', handleAi)
      server.httpServer.once('close', () => { void pool.end() })
    },
  }
}
