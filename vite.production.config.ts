import { defineConfig, loadEnv } from 'vite'
import { layrrBridgePlugin } from './server/layrrBridge'
import { llmProxyPlugin } from './server/llmProxy'
import { mysqlStoragePlugin } from './server/mysqlStorage'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const mysqlConfig = {
    host: env.MYSQL_HOST || 'localhost',
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER || 'root',
    password: env.MYSQL_PASSWORD || '',
    database: env.MYSQL_DATABASE || 'db_proto',
  }
  return {
    plugins: [llmProxyPlugin(), mysqlStoragePlugin(mysqlConfig), layrrBridgePlugin(mysqlConfig)],
    preview: { allowedHosts: true },
  }
})
