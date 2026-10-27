import { createApp, h, nextTick, ref } from 'vue'
import ElementPlus from 'element-plus'
import TMagicEditor from '@tmagic/editor'
import TMagicElementPlusAdapter from '@tmagic/element-plus-adapter'
import { NodeType, type MApp, type MNode } from '@tmagic/core'
import 'element-plus/dist/index.css'
import '@tmagic/editor/dist/style.css'
import './style.css'

type HtmlNode = MNode & { tag?: string; text?: string; attrs?: Record<string, string> }
const root = ref<MApp | null>(null)
const original = ref('')
const rendered = new Map<string, HTMLElement>()
const status = ref('正在读取小豆原型工作区…')
const loadError = ref('')
const id = new URLSearchParams(location.search).get('workspace')
let revision = ''

async function api(method = 'GET', payload?: unknown) {
  const response = await fetch(`/api/layrr/${id}/document`, {
    method,
    headers: { 'x-quickpage-layrr': '1', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? '工作区请求失败')
  return result
}

function toDsl(node: Element, path: string): HtmlNode {
  const id = `html-${path}`
  const attrs: Record<string, string> = {}
  for (const attr of [...node.attributes]) attrs[attr.name] = attr.value
  const items = [...node.children]
    .map((child, index) => ({ child, index }))
    .filter(({ child }) => !['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(child.tagName))
    .map(({ child, index }) => toDsl(child, `${path}-${index}`))
  return {
    id,
    type: node.children.length ? NodeType.CONTAINER : 'text',
    name: node.tagName.toLowerCase(),
    tag: node.tagName.toLowerCase(),
    text: node.children.length ? undefined : node.textContent ?? '',
    attrs,
    style: { ...Object.fromEntries([...((node as HTMLElement).style ?? [])].map((key) => [key, (node as HTMLElement).style.getPropertyValue(key)])) },
    items,
  } as HtmlNode
}
function markSource(node: Element, path: string) {
  if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.tagName)) return
  node.setAttribute('data-qp-editor-node', `html-${path}`)
  ;[...node.children].forEach((child, index) => markSource(child, `${path}-${index}`))
}

function renderNode(node: HtmlNode): HTMLElement {
  const safeTag = /^[a-z][a-z0-9-]*$/i.test(node.tag ?? '') ? node.tag! : 'div'
  const el = document.createElement(safeTag)
  el.setAttribute('data-tmagic-id', String(node.id))
  rendered.set(String(node.id), el)
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    if (/^on/i.test(name) || name === 'id') continue
    try { el.setAttribute(name, value) } catch { /* invalid imported attribute */ }
  }
  Object.assign(el.style, node.style ?? {})
  if (node.items?.length) node.items.forEach((child: MNode) => el.append(renderNode(child as HtmlNode)))
  else el.textContent = node.text ?? ''
  return el
}

async function save() {
  if (!root.value || !original.value) return
  const doc = new DOMParser().parseFromString(original.value, 'text/html')
  const configPage = root.value.items?.[0] as HtmlNode | undefined
  const visited = new Set<string>()
  function apply(node: HtmlNode, parent: Element) {
    const key = String(node.id)
    visited.add(key)
    let target = doc.querySelector(`[data-qp-editor-node="${CSS.escape(key)}"]`)
    const renderedEl = rendered.get(key)
    if (!target) {
      const tag = /^[a-z][a-z0-9-]*$/i.test(node.tag ?? '') ? node.tag! : 'div'
      target = doc.createElement(tag)
    }
    if (renderedEl) {
      for (const attr of [...target.attributes]) {
        if (attr.name !== 'data-qp-editor-node' && !renderedEl.hasAttribute(attr.name)) target.removeAttribute(attr.name)
      }
      for (const attr of [...renderedEl.attributes]) {
        if (attr.name !== 'data-tmagic-id') target.setAttribute(attr.name, attr.value)
      }
      if (node.items?.length) {
        for (const child of [...(node.items as HtmlNode[])]) apply(child, target)
        const retained = new Set((node.items as HtmlNode[]).map((child) => String(child.id)))
        target.querySelectorAll('[data-qp-editor-node]').forEach((el) => {
          if (!retained.has(el.getAttribute('data-qp-editor-node') ?? '') && ![...retained].some((id) => el.querySelector(`[data-qp-editor-node="${CSS.escape(id)}"]`))) el.remove()
        })
      } else {
        target.textContent = renderedEl.textContent ?? ''
      }
    }
    parent.append(target)
  }
  if (configPage) {
    const body = doc.body
    const sourceNodes = [...body.querySelectorAll('[data-qp-editor-node]')]
    const topLevel = (configPage.items ?? []) as HtmlNode[]
    const editable = new Set(topLevel.map((node) => String(node.id)))
    sourceNodes.forEach((node) => {
      const parentId = node.parentElement?.getAttribute('data-qp-editor-node')
      const nodeId = node.getAttribute('data-qp-editor-node')
      if (!parentId && nodeId && !editable.has(nodeId)) node.remove()
    })
    topLevel.forEach((node) => apply(node, body))
  }
  doc.querySelectorAll('[data-qp-editor-node]').forEach((el) => el.removeAttribute('data-qp-editor-node'))
  const html = '<!doctype html>\n' + doc.documentElement.outerHTML
  const result = await api('POST', { html, revision })
  revision = result.revision
  original.value = html
  status.value = '已写入独立工作区；返回小豆原型确认导入当前迭代。'
}

async function load() {
  if (!id) throw new Error('缺少工作区 ID')
  const data = await api()
  original.value = data.html
  revision = data.revision
  const doc = new DOMParser().parseFromString(data.html, 'text/html')
  const body = [...doc.body.children].map((node, index) => toDsl(node, `${index}`))
  // 标记源文档中的同一批节点，保存时只回写其被编辑的样式和文本。
  ;[...doc.body.children].forEach((node, index) => markSource(node, `${index}`))
  original.value = '<!doctype html>\n' + doc.documentElement.outerHTML
  root.value = {
    type: NodeType.ROOT,
    id: `quickpage-${id}`,
    items: [{ type: NodeType.PAGE, id: `page-${id}`, name: '页面', style: { width: 1440, height: 1000 }, items: body }],
  } as MApp
  status.value = '使用 tmagic-editor 编辑。完成后点击“写入工作区”，再返回小豆原型确认保存。'
}

const componentGroupList = [{ title: '网页元素', items: [
  { text: '容器', type: NodeType.CONTAINER },
  { text: '文字', type: 'text' },
] }]
const propsConfigs = {
  text: [{ name: 'text', text: '文字内容', type: 'textarea' }],
  [NodeType.CONTAINER]: [{ name: 'name', text: '元素名称', type: 'text' }],
}
const propsValues = { text: { text: '双击编辑文字' }, [NodeType.CONTAINER]: { name: '容器' } }
function parseDslWithoutEval(source: string) {
  const trimmed = source.trim()
  return JSON.parse(trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1) : trimmed)
}
const render = async () => {
  await nextTick()
  const page = root.value?.items?.[0] as HtmlNode | undefined
  const canvas = document.createElement('div')
  canvas.className = 'qp-tmagic-canvas'
  rendered.clear()
  const doc = new DOMParser().parseFromString(original.value, 'text/html')
  doc.head.querySelectorAll('style,link[rel="stylesheet"]').forEach((sheet) => {
    canvas.append(sheet.cloneNode(true))
  })
  page?.items?.forEach((node: MNode) => canvas.append(renderNode(node as HtmlNode)))
  return canvas
}

void load().catch((error) => { status.value = error.message; loadError.value = error.message })
const App = {
  setup: () => () => h('main', { class: 'qp-tmagic' }, [
    h('header', [h('strong', '小豆原型局部编辑 · tmagic-editor'), h('button', { onClick: () => void save() }, '写入工作区')]),
    h('p', { class: 'qp-status' }, status.value),
    loadError.value ? h('pre', { class: 'qp-error' }, loadError.value) : root.value ? h(TMagicEditor, {
      modelValue: root.value,
      'onUpdate:modelValue': (value: MApp) => { root.value = value },
      componentGroupList,
      propsConfigs,
      propsValues,
      render,
      stageRect: { width: 1440, height: 1000 },
      disabledDataSource: true,
      disabledCodeBlock: true,
      disabledStageOverlay: true,
    }) : h('div', { class: 'qp-loading' }, '正在载入原型 HTML…'),
  ]),
}
createApp(App).use(ElementPlus).use(TMagicEditor, { ...TMagicElementPlusAdapter, parseDSL: parseDslWithoutEval }).mount('#tmagic-editor')

