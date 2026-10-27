import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { createJiti } from 'jiti'
import { createServer, loadEnv } from 'vite'

/** Real HTTP/MySQL integration, isolated from the user's project database. */
export async function startStorageTest(t) {
  const originalCaptchaCode = process.env.QUICKPAGE_CAPTCHA_TEST_CODE
  process.env.QUICKPAGE_CAPTCHA_TEST_CODE = 'A2B3'
  const root = fileURLToPath(new URL('../', import.meta.url))
  const env = loadEnv('development', root, '')
  const database = `qp_test_${randomUUID().replaceAll('-', '')}`
  assert.match(database, /^qp_test_[a-f0-9]{32}$/)
  const config = { host: env.MYSQL_HOST || 'localhost', port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER || 'root', password: env.MYSQL_PASSWORD || '' }
  const admin = await mysql.createConnection(config)
  let server
  let connection
  const originalFetch = globalThis.fetch
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    const jiti = createJiti(import.meta.url, { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } })
    const { mysqlStoragePlugin } = await jiti.import('../server/mysqlStorage.ts')
    server = await createServer({ configFile: false, root, logLevel: 'silent', plugins: [mysqlStoragePlugin({ ...config, database })], server: { host: '127.0.0.1', port: 0, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } })
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    const cookieJar = { value: '' }
    globalThis.fetch = async (input, options = {}) => {
      const url = typeof input === 'string' && input.startsWith('/') ? base + input : input
      const headers = new Headers(options.headers)
      if (cookieJar.value) headers.set('cookie', cookieJar.value)
      const response = await originalFetch(url, { ...options, headers })
      const cookie = response.headers.get('set-cookie')
      if (cookie) cookieJar.value = cookie.split(';')[0]
      return response
    }
    connection = await mysql.createConnection({ ...config, database })
    const repositories = await jiti.import('../src/services/storage/repositories.ts')
    const { storageRequest } = await jiti.import('../src/services/storage/db.ts')
    const setupCaptcha = await storageRequest('auth.captcha', { purpose: 'setup' })
    await storageRequest('auth.setup', { email: 'admin@test.local', password: 'Testpass123!', displayName: 'Test Admin', tenantName: 'Test Tenant', captchaId: setupCaptcha.id, captchaCode: 'A2B3' })
    const counts = async () => {
      const result = {}
      for (const table of ['projects', 'pages', 'page_versions', 'source_docs', 'assets']) {
        const [rows] = await connection.query(`SELECT COUNT(*) total FROM \`${table}\``)
        result[table] = Number(rows[0].total)
      }
      return result
    }
    t.after(async () => {
      globalThis.fetch = originalFetch
      await server.close()
      await connection.end()
      await admin.query(`DROP DATABASE \`${database}\``)
      await admin.end()
      if (originalCaptchaCode === undefined) delete process.env.QUICKPAGE_CAPTCHA_TEST_CODE; else process.env.QUICKPAGE_CAPTCHA_TEST_CODE = originalCaptchaCode
    })
    const client = () => {
      let cookie = ''
      const request = async (action, input = {}) => {
        const response = await originalFetch(base + '/api/storage', { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ action, input }) })
        const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0]
        const payload = await response.json()
        return { status: response.status, payload }
      }
      return async (action, input = {}) => {
        if (['auth.setup','auth.login','auth.register'].includes(action) && !input.captchaId) {
          const purpose = action.slice(5)
          const challenge = await request('auth.captcha', { purpose })
          input = { ...input, captchaId: challenge.payload.result.id, captchaCode: 'A2B3' }
        }
        return request(action, input)
      }
    }
    return { ...repositories, storageRequest, connection, counts, base, fetch: globalThis.fetch, client }
  } catch (error) {
    globalThis.fetch = originalFetch
    await server?.close()
    await connection?.end()
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``)
    await admin.end()
    if (originalCaptchaCode === undefined) delete process.env.QUICKPAGE_CAPTCHA_TEST_CODE; else process.env.QUICKPAGE_CAPTCHA_TEST_CODE = originalCaptchaCode
    throw error
  }
}
