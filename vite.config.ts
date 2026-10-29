import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'
import { layrrBridgePlugin } from './server/layrrBridge'
import { llmProxyPlugin } from './server/llmProxy'
import { mysqlStoragePlugin } from './server/mysqlStorage'

const tmagicEditorEntry = fileURLToPath(new URL('./tmagic-editor.html', import.meta.url))

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const mysqlConfig = {
    host: env.MYSQL_HOST || 'localhost', port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER || 'root', password: env.MYSQL_PASSWORD || '', database: env.MYSQL_DATABASE || 'db_proto',
  }
  return {
  plugins: [
    vue(),
    vueDevTools(),
    Components({
      resolvers: [NaiveUiResolver()],
      dts: 'src/components.d.ts',
    }),
    llmProxyPlugin(),
    mysqlStoragePlugin(mysqlConfig),
    layrrBridgePlugin(mysqlConfig),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: { input: { index: fileURLToPath(new URL('./index.html', import.meta.url)), tmagic: tmagicEditorEntry } },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
  preview: {
    // Production binds to loopback and is reached through the configured Nginx host.
    allowedHosts: true,
  },
  }
})
