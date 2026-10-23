export function gridstackEditorShell(prefix: string): string {
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>QuickPage GridStack 网格编辑</title><link rel="stylesheet" href="' +
    prefix +
    '/__layrr__/gridstack.css"><style>*{box-sizing:border-box}body{margin:0;font:13px system-ui;background:#f1f5f9;color:#334155}header{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:white;padding:12px 20px;border-bottom:1px solid #ddd}button{padding:7px 12px;border:1px solid #cbd5e1;border-radius:6px;background:white;cursor:pointer}button:disabled{opacity:.4;cursor:default}#save{background:#2563eb;color:white}#notice{padding:10px 20px;background:#eff6ff}#status{padding:10px 20px;color:#2563eb}#source{width:100%;height:70vh;border:0;background:white}#canvas{margin:16px auto;background:white;max-width:100%;min-height:300px}.grid-stack-item-content{border:1px solid #93c5fd;background:white;overflow:hidden!important}.card-handle{height:24px;background:#eff6ff;cursor:grab;padding:2px 8px;font-size:11px;position:absolute;top:0;left:0;right:0;z-index:2}.card-preview{width:100%;height:100%;border:0;pointer-events:none;padding-top:24px}.grid-stack-placeholder>.placeholder-content{background:#bfdbfe}#canvas[hidden],#source[hidden]{display:none}</style></head><body><header><strong>GridStack 独立网格编辑</strong><span>不调用 AI</span><button id="convert" disabled>转换选中容器</button><button id="undo" disabled>撤销</button><button id="redo" disabled>重做</button><button id="download" disabled>导出 HTML</button><button id="save" disabled>写入工作区</button></header><div id="notice">先在原页面点选要转换的容器；只拆分它的直接子模块。转换会改变该区域布局，脚本在编辑时暂停。拖动卡片顶部移动、边缘缩放；网格吸附并自动避让（不会自动缩放文字）。写入后仍需回 QuickPage 确认保存。</div><div id="status" role="status">正在载入…</div><iframe id="source" sandbox="allow-same-origin"></iframe><div id="canvas" class="grid-stack" hidden></div><script src="' +
    prefix +
    '/__layrr__/gridstack.js"></script><script type="module" src="' +
    prefix +
    '/__layrr__/gridstack-client.js"></script></body></html>'
  )
}
