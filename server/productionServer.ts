import { loadEnv, preview } from 'vite'

import { layrrBridgePlugin } from './layrrBridge'
import { llmProxyPlugin } from './llmProxy'
import { mysqlStoragePlugin } from './mysqlStorage'

const env = loadEnv('production', process.cwd(), '')
const port = Number(env.APP_PORT || 4173)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`APP_PORT 格式无效：${env.APP_PORT || ''}`)
}

const mysqlConfig = {
  host: env.MYSQL_HOST || 'localhost',
  port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER || 'root',
  password: env.MYSQL_PASSWORD || '',
  database: env.MYSQL_DATABASE || 'db_proto',
}

const server = await preview({
  configFile: false,
  root: process.cwd(),
  plugins: [llmProxyPlugin(), mysqlStoragePlugin(mysqlConfig), layrrBridgePlugin(mysqlConfig)],
  preview: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    allowedHosts: true,
  },
})

server.printUrls()

const shutdown = async () => {
  await server.close()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
