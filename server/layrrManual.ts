import { createHash } from 'node:crypto'

export function htmlRevision(html: string): string {
  return createHash('sha256').update(html).digest('hex')
}

export function validateManualSave(input: Record<string, unknown>, current: string, busy: boolean) {
  if (busy) throw new Error('AI 修改进行中，请完成后刷新手动工作区')
  if (typeof input.revision !== 'string' || input.revision !== htmlRevision(current))
    throw new Error('工作区已被其他窗口修改，请先复制需要保留的文字，再重新载入')
  if (typeof input.html !== 'string' || !input.html.trim()) throw new Error('修改内容为空')
  return input.html
}

export function manualEditorShell(prefix: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QuickPage 手动编辑 · 不调用 AI</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;color:#263247;background:#f3f5f9}header{height:62px;background:#fff;border-bottom:1px solid #dde3ed;display:flex;align-items:center;gap:10px;padding:10px 16px}header strong{margin-right:auto}button,input,textarea{font:inherit}button{cursor:pointer;border:1px solid #cbd5e1;background:#fff;border-radius:6px;padding:7px 10px;color:#263247}button:disabled{opacity:.45;cursor:default}button.primary{background:#2563eb;color:#fff;border-color:#2563eb}.layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;height:calc(100vh - 98px)}iframe{border:0;width:100%;height:100%;background:#fff}aside{background:#fff;border-left:1px solid #dde3ed;overflow:auto;padding:16px}aside h3{font-size:14px;margin:18px 0 8px}aside p{font-size:12px;color:#64748b;line-height:1.6}label{display:block;font-size:12px;margin:10px 0 5px}input,textarea{width:100%;border:1px solid #cbd5e1;border-radius:5px;padding:7px;background:#fff;color:#263247}textarea{resize:vertical;min-height:80px}.row{display:flex;gap:7px}.row>*{flex:1;min-width:0}#status{height:36px;padding:8px 16px;font-size:12px;border-top:1px solid #dde3ed}#status[data-error="true"]{color:#b91c1c}#selection{overflow-wrap:anywhere;color:#2563eb}#dirty{font-size:12px;color:#64748b}input[type=color]{height:34px;padding:3px}#props[hidden]{display:none}
</style></head><body>
<header><strong>手动编辑 <small>· 不调用 AI</small></strong><label for="dragMode" style="margin:0">拖动模式</label><select id="dragMode" style="font:inherit;padding:6px;border:1px solid #cbd5e1;border-radius:6px"><option value="free">自由拖动</option><option value="parent">父容器内拖拽</option><option value="reorder">模块重排</option></select><span id="dirty">正在载入</span><button id="undo" disabled>撤销</button><button id="redo" disabled>重做</button><button id="reload">重新载入</button><button id="save" class="primary" disabled>写入工作区</button></header>
<div class="layout"><iframe id="canvas" title="手动编辑画布" sandbox="allow-scripts allow-same-origin"></iframe><aside>
<h3>选中模块 / 元素</h3><p id="selection">点击画布中的元素；双击文字开始修改。</p>
<div id="props" hidden><div class="row"><button id="parent">选择父级</button><button id="child">选择子级</button></div>
<div id="childPicker" hidden><label for="children">选择直接子元素</label><select id="children" style="width:100%;padding:7px;margin-bottom:10px"></select></div>
<div class="row" style="margin-top:8px"><button id="duplicate">复制</button><button id="delete">删除</button></div>
<label for="text">文字（双击元素后编辑）</label><textarea id="text"></textarea><p id="textHint"></p><button id="applyText">应用文字</button>
<section id="imageEditor" hidden><h3>更换图片 / SVG</h3><p>上传的图片内嵌保存（单张最多 2 MB）。网络地址会由浏览器访问，需保持可用。SVG 以图片方式展示，不执行上传文件中的脚本。</p>
<label for="imageFile">上传图片或 SVG</label><input id="imageFile" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon">
<label for="imageUrl">网络图片地址</label><input id="imageUrl" type="url" placeholder="https://example.com/image.svg"><button id="applyImage" style="margin-top:8px">使用网络图片</button><p id="imageHint"></p></section>
<h3>颜色</h3><div class="row"><div><label for="color">文字颜色</label><input id="color" type="color" data-style="color"></div><div><label for="backgroundColor">背景颜色</label><input id="backgroundColor" type="color" data-style="background-color"></div></div>
<h3>尺寸与间距</h3><p>支持 px、%、rem 等 CSS 单位；留空清除手动覆盖。修改后按回车或移开焦点生效。</p>
<label for="fontSize">字号</label><input id="fontSize" data-style="font-size" placeholder="例如 16px">
<div class="row"><div><label for="width">宽度</label><input id="width" data-style="width" placeholder="auto / 200px"></div><div><label for="height">高度</label><input id="height" data-style="height" placeholder="auto / 80px"></div></div>
<label for="padding">内边距</label><input id="padding" data-style="padding" placeholder="例如 12px 16px">
<label for="margin">外边距</label><input id="margin" data-style="margin" placeholder="例如 0 auto">
<label for="borderRadius">圆角</label><input id="borderRadius" data-style="border-radius" placeholder="例如 8px">
</div>
</aside></div><div id="status" role="status">正在载入页面…</div>
<script src="${prefix}/__layrr__/interact.js"></script><script type="module" src="${prefix}/__layrr__/manual.js"></script></body></html>`
}
