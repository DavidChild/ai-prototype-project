import { mergeConfig } from 'vite'
import config from '../vite.config.ts'

export default mergeConfig(config, {
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
  plugins: [{
    name: 'isolated-page-tree-preview',
    transformIndexHtml(html) {
      return html.replace('/src/main.ts', '/tests/pageTree.preview.ts')
    },
  }],
})
