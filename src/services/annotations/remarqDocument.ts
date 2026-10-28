import type { AnnotationStore } from 'web-remarq'
import webRemarqRuntime from '../../../node_modules/web-remarq/dist/web-remarq.global.js?raw'
import { ANNOTATION_DIRECTION_OPTIONS } from './annotationDirections'
import { QUALITY_CONFIRMATION_OPTIONS } from './qualityConfirmationOptions'
import { adaptWebRemarqRuntime } from './remarqLocalization'

export const EMPTY_ANNOTATION_STORE: AnnotationStore = { version: 1, annotations: [] }

const localizedWebRemarqRuntime = adaptWebRemarqRuntime(webRemarqRuntime)

export function cloneAnnotationStore(store?: AnnotationStore): AnnotationStore {
  return JSON.parse(JSON.stringify(store ?? EMPTY_ANNOTATION_STORE)) as AnnotationStore
}

export function remarqExportStorageKey(
  projectId: string,
  pageId: string,
  store: AnnotationStore | undefined,
): string {
  const source = JSON.stringify(store ?? EMPTY_ANNOTATION_STORE)
  let hash = 2166136261
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `quickpage:export-annotations:${projectId}:${pageId}:${(hash >>> 0).toString(36)}`
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
}

function safeScript(source: string): string {
  return source.replaceAll('</script', '<\\/script')
}

function injectBeforeBodyEnd(html: string, content: string): string {
  return /<\/body\s*>/i.test(html)
    ? html.replace(/<\/body\s*>/i, `${content}</body>`)
    : `${html}${content}`
}

function bootstrapScript(config: {
  store: AnnotationStore
  theme: 'light' | 'dark'
  channel?: string
  storageKey?: string
  autoInspect?: boolean
  readOnly?: boolean
}): string {
  return `<script>
(() => {
  const initialStore = ${safeJson(config.store)};
  const channel = ${safeJson(config.channel ?? '')};
  const storageKey = ${safeJson(config.storageKey ?? '')};
  const readOnly = ${config.readOnly ? 'true' : 'false'};
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const annotationDirectionOptions = ${safeJson(ANNOTATION_DIRECTION_OPTIONS)};
  const qualityConfirmationOptions = ${safeJson(QUALITY_CONFIRMATION_OPTIONS)};
  const popupOverrides = document.createElement('style');
  popupOverrides.id = 'quickpage-remarq-overrides';
  popupOverrides.textContent = [
    '.remarq-popup { width: min(480px, calc(100vw - 24px)) !important; max-height: calc(100vh - 24px); display: flex; flex-direction: column; }',
    '.remarq-popup-header, .remarq-popup-actions { flex: 0 0 auto; }',
    '.remarq-popup-body { overflow-y: auto; line-height: 1.65; }',
    '.remarq-popup-body > div:first-child:not([class]) { white-space: pre-wrap; overflow-wrap: anywhere; }',
    '.remarq-popup textarea, .remarq-popup-edit-textarea { min-height: 220px !important; height: min(320px, 42vh); max-height: 50vh; line-height: 1.6; }',
    '.remarq-toolbar.quickpage-remarq-toolbar { width: 338px; box-sizing: border-box; flex-wrap: wrap; }',
    '.remarq-toolbar.quickpage-remarq-toolbar.remarq-minimized { width: auto; }',
    '.quickpage-remarq-ai-tools { flex: 0 0 100%; display: grid; grid-template-columns: 1fr; gap: 6px; padding-top: 7px; margin-top: 3px; border-top: 1px solid var(--remarq-border); }',
    '.remarq-toolbar.remarq-minimized .quickpage-remarq-ai-tools { display: none; }',
    '.quickpage-remarq-ai-btn { min-width: 0; height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 8px; border: 0; border-radius: 6px; background: var(--remarq-bg-secondary); color: var(--remarq-text); font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; cursor: pointer; white-space: nowrap; }',
    '.quickpage-remarq-ai-btn:hover { background: var(--remarq-accent); color: #fff; }',
    '.quickpage-remarq-ai-btn:focus-visible { outline: 2px solid var(--remarq-accent); outline-offset: 1px; }',
    '.quickpage-remarq-ai-btn svg { width: 15px; height: 15px; flex: 0 0 auto; }',
    '.quickpage-remarq-popup-ai { display: grid; gap: 7px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--remarq-border); }',
    '.quickpage-remarq-popup-ai-label { color: var(--remarq-text); font-size: 12px; font-weight: 600; }',
    '.quickpage-remarq-popup-ai-hint { color: var(--remarq-text-secondary); font-size: 11px; line-height: 1.45; }',
    '.quickpage-remarq-direction-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 10px; }',
    '.quickpage-remarq-direction { min-width: 0; display: flex; align-items: center; gap: 6px; color: var(--remarq-text); font-size: 12px; cursor: pointer; }',
    '.quickpage-remarq-direction input { width: 14px; height: 14px; margin: 0; accent-color: var(--remarq-accent); flex: 0 0 auto; }',
    '.quickpage-remarq-direction span { min-width: 0; overflow-wrap: anywhere; }',
    '.remarq-popup textarea.quickpage-remarq-ai-instruction { min-height: 68px !important; height: 68px !important; max-height: 120px; }',
    '.quickpage-remarq-generate-btn { height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--remarq-accent); border-radius: 5px; background: transparent; color: var(--remarq-accent); font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; cursor: pointer; }',
    '.quickpage-remarq-generate-btn:hover { background: var(--remarq-accent); color: #fff; }',
    '.quickpage-remarq-generate-btn:disabled { opacity: .65; cursor: wait; }',
    '.quickpage-remarq-generate-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }',
    '.quickpage-remarq-add-actions { display: grid !important; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }',
    '.quickpage-remarq-add-actions button { width: 100%; min-height: 34px; }',
    '.quickpage-remarq-add-actions button:disabled { opacity: .45; cursor: not-allowed; }',
    '.quickpage-remarq-ai-status { min-height: 17px; color: var(--remarq-text-secondary); font-size: 11px; line-height: 1.45; }',
    '.quickpage-remarq-ai-status[data-error="true"] { color: #ef4444; }',
    '.quickpage-remarq-quality { display: grid; gap: 9px; margin-top: 12px; padding: 11px; border: 1px dashed var(--remarq-border); border-radius: 6px; }',
    '.quickpage-remarq-quality-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }',
    '.quickpage-remarq-quality-title { color: var(--remarq-text); font-size: 12px; font-weight: 700; }',
    '.quickpage-remarq-quality-score { font-size: 11px; font-weight: 700; }',
    '.quickpage-remarq-quality-score[data-score="clear"] { color: #22c55e; }',
    '.quickpage-remarq-quality-score[data-score="ambiguous"] { color: #eab308; }',
    '.quickpage-remarq-quality-score[data-score="unactionable"] { color: #f97316; }',
    '.quickpage-remarq-quality-section { display: grid; gap: 4px; color: var(--remarq-text); font-size: 12px; }',
    '.quickpage-remarq-quality-section strong { font-size: 11px; }',
    '.quickpage-remarq-quality-section ul { margin: 0; padding-left: 18px; }',
    '.quickpage-remarq-confirm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 10px; }',
    '.quickpage-remarq-confirm-option { min-width: 0; display: flex; align-items: flex-start; gap: 7px; padding: 7px 8px; border: 1px solid var(--remarq-border); border-radius: 5px; color: var(--remarq-text); font-size: 11px; line-height: 1.35; cursor: pointer; }',
    '.quickpage-remarq-confirm-option:has(input:checked) { border-color: var(--remarq-accent); background: color-mix(in srgb, var(--remarq-accent) 10%, transparent); }',
    '.quickpage-remarq-confirm-option input { width: 14px; height: 14px; margin: 1px 0 0; accent-color: var(--remarq-accent); flex: 0 0 auto; }',
    '.quickpage-remarq-confirm-option span { min-width: 0; overflow-wrap: anywhere; }',
    '.remarq-popup textarea.quickpage-remarq-confirm-instruction { min-height: 68px !important; height: 68px !important; max-height: 120px; }',
    '.quickpage-remarq-quality-actions { display: flex; flex-wrap: wrap; gap: 6px; }',
    '.quickpage-remarq-quality-btn { min-height: 30px; padding: 0 10px; border: 1px solid var(--remarq-border); border-radius: 5px; background: var(--remarq-bg-secondary); color: var(--remarq-text); font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; cursor: pointer; }',
    '.quickpage-remarq-quality-btn:hover { border-color: var(--remarq-accent); color: var(--remarq-accent); }',
    '.quickpage-remarq-quality-btn:disabled { opacity: .6; cursor: wait; }',
    '.quickpage-remarq-quality-btn--primary { border-color: var(--remarq-accent); background: var(--remarq-accent); color: #fff; }',
    '.remarq-popup textarea.quickpage-remarq-quality-draft { min-height: 180px !important; height: min(260px, 34vh) !important; max-height: 42vh; }',
    '.quickpage-remarq-quality-status { min-height: 17px; color: var(--remarq-text-secondary); font-size: 11px; line-height: 1.45; }',
    '.quickpage-remarq-quality-status[data-error="true"] { color: #ef4444; }',
    '.quickpage-remarq-edit-actions { display: flex; justify-content: flex-end; margin-top: 8px; }',
    '.quickpage-remarq-save-btn { min-height: 32px; padding: 0 14px; border: 1px solid var(--remarq-accent); border-radius: 5px; background: var(--remarq-accent); color: #fff; font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; cursor: pointer; }',
    '.quickpage-remarq-save-btn:hover { filter: brightness(1.06); }',
    '.quickpage-remarq-save-btn:focus-visible { outline: 2px solid var(--remarq-accent); outline-offset: 2px; }',
    'html[data-quickpage-remarq-readonly] [data-remarq-action="inspect"], html[data-quickpage-remarq-readonly] [data-remarq-action="spacing"], html[data-quickpage-remarq-readonly] [data-remarq-action="submit"], html[data-quickpage-remarq-readonly] [data-remarq-action="import"], html[data-quickpage-remarq-readonly] [data-remarq-action="clear"], html[data-quickpage-remarq-readonly] [data-remarq-action="export"] { display: none !important; }',
    'html[data-quickpage-remarq-readonly] .remarq-popup-actions-row--transitions { display: none !important; }',
    'html[data-quickpage-remarq-readonly] .remarq-popup-quality-actions { display: none !important; }',
    'html[data-quickpage-remarq-readonly] .quickpage-remarq-popup-ai, html[data-quickpage-remarq-readonly] .quickpage-remarq-quality, html[data-quickpage-remarq-readonly] .quickpage-remarq-edit-actions { display: none !important; }',
    'html[data-quickpage-remarq-readonly] .remarq-popup-body > div:first-child { cursor: default !important; }',
  ].join('');
  document.head.appendChild(popupOverrides);
  document.documentElement.toggleAttribute('data-quickpage-remarq-readonly', readOnly);
  const route = () => location.pathname + location.hash;
  const remapRoute = (value) => {
    const saved = typeof value === 'string' ? value : '';
    const hashIndex = saved.indexOf('#');
    return location.pathname + (hashIndex >= 0 ? saved.slice(hashIndex) : '');
  };
  const normalize = (input) => ({
    version: 1,
    annotations: Array.isArray(input?.annotations)
      ? input.annotations.map((item) => ({ ...item, route: remapRoute(item.route) }))
      : [],
  });
  const stableClasses = (element) => Array.from(element.classList).filter((name) =>
    !/^(?:sc-|css-)/.test(name) &&
    !/^[a-zA-Z0-9]{8,}$/.test(name) &&
    !/__[a-zA-Z0-9]{3,}$/.test(name)
  );
  const elementText = (element) => {
    let text = '';
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent || '';
    }
    text = text.trim();
    if (!text && element.children.length <= 3) text = (element.textContent || '').trim();
    return text ? text.slice(0, 80) : '';
  };
  const domPath = (element) => {
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 5) {
      let segment = current.tagName.toLowerCase();
      const classes = stableClasses(current);
      if (classes.length) segment += '.' + classes.slice(0, 2).join('.');
      parts.unshift(segment);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const fingerprint = (element) => {
    let parentAnchor = null;
    let parentElement = element.parentElement;
    while (parentElement && parentElement !== document.body) {
      parentAnchor = parentElement.getAttribute('data-annotate');
      if (parentAnchor) break;
      parentElement = parentElement.parentElement;
    }
    const rawClasses = Array.from(element.classList);
    const id = element.id && !/^[a-zA-Z0-9]{8,}$/.test(element.id) ? element.id : null;
    return {
      dataAnnotate: element.getAttribute('data-annotate'),
      dataTestId: element.getAttribute('data-testid') || element.getAttribute('data-test') || element.getAttribute('data-cy'),
      id,
      tagName: element.tagName.toLowerCase(),
      textContent: elementText(element).slice(0, 50) || null,
      role: element.getAttribute('role'),
      ariaLabel: element.getAttribute('aria-label'),
      stableClasses: stableClasses(element),
      domPath: domPath(element),
      siblingIndex: element.parentElement ? Array.from(element.parentElement.children).indexOf(element) : 0,
      parentAnchor,
      rawClasses,
      cssModules: [],
      sourceLocation: null,
      componentName: null,
      detectedSource: null,
      detectedComponent: null,
    };
  };
  const fingerprintKey = (value) => JSON.stringify([
    value?.dataAnnotate,
    value?.dataTestId,
    value?.id,
    value?.domPath,
    value?.siblingIndex,
  ]);
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width >= 8 && rect.height >= 8 && style.display !== 'none' &&
      style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };
  const describeElement = (element) => {
    const own = elementText(element);
    const parent = element.parentElement ? (element.parentElement.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 180) : '';
    const details = [
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      element.getAttribute('name'),
      element.getAttribute('type'),
      own,
    ].filter(Boolean);
    return {
      label: details.join(' · ').slice(0, 160) || element.tagName.toLowerCase(),
      context: parent || own || element.outerHTML.slice(0, 240),
    };
  };
  const candidateScore = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role') || '';
    const classes = Array.from(element.classList).join(' ').toLowerCase();
    let score = 0;
    if (element.id || element.hasAttribute('data-annotate') || element.hasAttribute('data-testid')) score += 5;
    if (/^(button|input|select|textarea|label|table|th|dialog|form)$/.test(tag)) score += 7;
    if (/button|textbox|combobox|dialog|alert|table|tab|switch|menuitem/.test(role)) score += 5;
    if (/field|form|modal|dialog|drawer|recommend|frequency|rule|status|permission|table|card|metric/.test(classes)) score += 4;
    const text = elementText(element);
    if (text.length >= 2 && text.length <= 100) score += 2;
    if (element.children.length > 20) score -= 5;
    return score;
  };
  const elementEvidence = (element) => ({
    tagName: element.tagName.toLowerCase(),
    id: element.id || null,
    role: element.getAttribute('role'),
    ariaLabel: element.getAttribute('aria-label'),
    classes: stableClasses(element).slice(0, 6),
    text: elementText(element).slice(0, 120) || null,
    childCount: element.children.length,
  });
  const elementStructure = (element) => {
    const ancestors = [];
    let current = element.parentElement;
    while (current && current !== document.body && ancestors.length < 6) {
      ancestors.push({ ...elementEvidence(current), level: ancestors.length + 1 });
      current = current.parentElement;
    }
    const siblings = element.parentElement
      ? Array.from(element.parentElement.children)
          .filter((item) => item !== element)
          .slice(0, 8)
          .map(elementEvidence)
      : [];
    return {
      target: elementEvidence(element),
      ancestors,
      children: Array.from(element.children).slice(0, 8).map(elementEvidence),
      siblings,
    };
  };
  const makeCandidate = (element, id) => {
    const description = describeElement(element);
    return {
      id,
      ...description,
      fingerprint: fingerprint(element),
      structure: id === 'selected' ? elementStructure(element) : undefined,
      route: route(),
      viewport: { width: innerWidth, height: innerHeight },
    };
  };
  const pageSnapshot = () => {
    const existing = globalThis.WebRemarq.getAnnotations(route()).map((item) => ({
      comment: item.comment,
      fingerprint: item.fingerprint,
    }));
    const existingKeys = new Set(existing.map((item) => fingerprintKey(item.fingerprint)));
    const ranked = Array.from(document.body.querySelectorAll('*'))
      .filter((element) =>
        element instanceof HTMLElement &&
        !/^(script|style|link|meta|html|body)$/.test(element.tagName.toLowerCase()) &&
        !element.closest('[data-remarq-theme]') &&
        isVisible(element)
      )
      .map((element) => ({ element, score: candidateScore(element) }))
      .filter((item) => item.score >= 5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 160);
    const seen = new Set();
    const candidates = [];
    for (const item of ranked) {
      const value = makeCandidate(item.element, 'c' + (candidates.length + 1));
      const key = fingerprintKey(value.fingerprint);
      if (seen.has(key) || existingKeys.has(key)) continue;
      seen.add(key);
      candidates.push(value);
      if (candidates.length >= 120) break;
    }
    return { candidates, existingAnnotations: existing };
  };
  const pickCandidate = () => new Promise((resolve, reject) => {
    const inspectButton = document.querySelector('[data-remarq-action="inspect"]');
    if (inspectButton?.classList.contains('remarq-active')) inspectButton.click();
    const hint = document.createElement('div');
    hint.textContent = '点击要生成 AI 标注的元素，按 Esc 取消';
    Object.assign(hint.style, {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '2147483647', padding: '8px 12px', borderRadius: '6px',
      background: '#111827', color: '#fff', font: '13px/1.4 system-ui, sans-serif',
      boxShadow: '0 6px 20px rgba(0,0,0,.28)', pointerEvents: 'none',
    });
    document.body.appendChild(hint);
    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';
    let hovered = null;
    let oldOutline = '';
    let oldOffset = '';
    const restoreHover = () => {
      if (!hovered) return;
      hovered.style.outline = oldOutline;
      hovered.style.outlineOffset = oldOffset;
      hovered = null;
    };
    const cleanup = () => {
      restoreHover();
      hint.remove();
      document.body.style.cursor = originalCursor;
      document.removeEventListener('mouseover', onHover, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
    const onHover = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('[data-remarq-theme]')) return;
      restoreHover();
      hovered = target;
      oldOutline = target.style.outline;
      oldOffset = target.style.outlineOffset;
      target.style.outline = '2px solid #18a058';
      target.style.outlineOffset = '2px';
    };
    const onClick = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest('[data-remarq-theme]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const candidate = makeCandidate(target, 'selected');
      const existing = globalThis.WebRemarq.getAnnotations(route());
      const match = existing.find((item) => fingerprintKey(item.fingerprint) === fingerprintKey(candidate.fingerprint));
      cleanup();
      resolve({ candidate, existingAnnotations: existing.map((item) => ({ comment: item.comment, fingerprint: item.fingerprint })), existingComment: match?.comment || '' });
    };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cleanup();
      reject(new Error('已取消选择元素'));
    };
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
  let store = normalize(initialStore);
  let requestSequence = 0;
  const pending = new Map();

  function post(kind, payload) {
    if (!channel) return Promise.resolve();
    const requestId = String(++requestSequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('工作台响应超时'));
      }, 30000);
      pending.set(requestId, { resolve, reject, timer });
      parent.postMessage({ source: 'quickpage-remarq', channel, requestId, kind, payload }, '*');
    });
  }

  async function handleHostCommand(data) {
    if (data.kind === 'scan') return pageSnapshot();
    if (data.kind === 'pick') return await pickCandidate();
    if (data.kind === 'append') {
      const incoming = Array.isArray(data.payload?.annotations) ? data.payload.annotations : [];
      const existing = globalThis.WebRemarq.getAnnotations();
      const keys = new Set(existing.map((item) => fingerprintKey(item.fingerprint)));
      const additions = incoming.filter((item) => {
        const key = fingerprintKey(item?.fingerprint);
        if (!item || keys.has(key)) return false;
        keys.add(key);
        return true;
      });
      if (!additions.length) return { added: 0, total: existing.length };
      const file = new File(
        [JSON.stringify({ version: 1, annotations: [...existing, ...additions] })],
        'ai-annotations.json',
        { type: 'application/json' },
      );
      const result = await globalThis.WebRemarq.import(file);
      return { ...result, added: additions.length };
    }
    throw new Error('未知的标注工作区操作');
  }

  addEventListener('message', async (event) => {
    const data = event.data;
    if (event.source !== parent || data?.channel !== channel) return;
    if (data.source === 'quickpage-remarq-host-command') {
      try {
        const result = await handleHostCommand(data);
        parent.postMessage({ source: 'quickpage-remarq-command-result', channel, requestId: data.requestId, ok: true, result }, '*');
      } catch (error) {
        parent.postMessage({ source: 'quickpage-remarq-command-result', channel, requestId: data.requestId, ok: false, error: error instanceof Error ? error.message : '标注操作失败' }, '*');
      }
      return;
    }
    if (data.source !== 'quickpage-remarq-host') return;
    const task = pending.get(data.requestId);
    if (!task) return;
    clearTimeout(task.timer);
    pending.delete(data.requestId);
    if (data.ok) task.resolve(data.result);
    else task.reject(new Error(data.error || '操作失败'));
  });

  function persistLocal() {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, JSON.stringify(store)); } catch {}
  }

  const storage = {
    async load() {
      if (readOnly) return clone(store);
      if (storageKey) {
        try {
          const saved = localStorage.getItem(storageKey);
          if (saved) store = normalize(JSON.parse(saved));
        } catch {}
      }
      return clone(store);
    },
    async save(annotation) {
      if (readOnly) return;
      const index = store.annotations.findIndex((item) => item.id === annotation.id);
      const saved = { ...annotation, route: remapRoute(annotation.route || route()) };
      if (index < 0) store.annotations.push(saved);
      else store.annotations[index] = saved;
      if (channel) await post('store', clone(store));
      else persistLocal();
    },
    async remove(id) {
      if (readOnly) return;
      store.annotations = store.annotations.filter((item) => item.id !== id);
      if (channel) await post('store', clone(store));
      else persistLocal();
    },
    async clear() {
      if (readOnly) return;
      store = { version: 1, annotations: [] };
      if (channel) await post('store', clone(store));
      else persistLocal();
    },
  };

  const qualityGate = { mode: 'off', check: async () => null };

  let pendingInspectedElement = null;
  document.addEventListener('click', (event) => {
    pendingInspectedElement = null;
    const target = event.target;
    const inspectButton = document.querySelector('[data-remarq-action="inspect"]');
    if (!(target instanceof HTMLElement) || target.closest('[data-remarq-theme]') ||
        !(inspectButton instanceof HTMLElement) || !inspectButton.classList.contains('remarq-active')) return;
    pendingInspectedElement = target;
  }, true);

  globalThis.WebRemarq.init({
    theme: ${safeJson(config.theme)},
    position: 'bottom-right',
    dataAttribute: 'data-annotate',
    submitFlow: false,
    shortcuts: !readOnly,
    storage,
    qualityGate,
  });
  let selectedElementForDraft = null;
  const keepEnterAsNewline = (textarea) => {
    if (!(textarea instanceof HTMLTextAreaElement) || textarea.dataset.quickpageEnterNewline === 'true') return;
    textarea.dataset.quickpageEnterNewline = 'true';
    // web-remarq submits on Enter. Capture first, stop its handler, and leave
    // the browser default untouched so Enter inserts a real newline.
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.stopImmediatePropagation();
    }, true);
  };
  const configureAddActions = (popup, textarea) => {
    const addButton = Array.from(popup.querySelectorAll('.remarq-popup-actions button'))
      .find((button) => button.textContent?.trim() === '保存标注');
    if (!(addButton instanceof HTMLButtonElement)) return;
    const actions = addButton.closest('.remarq-popup-actions');
    if (actions instanceof HTMLElement) actions.classList.add('quickpage-remarq-add-actions');
    const syncSaveButton = () => {
      addButton.disabled = !textarea.value.trim();
    };
    if (textarea.dataset.quickpageSaveGuard !== 'true') {
      textarea.dataset.quickpageSaveGuard = 'true';
      textarea.addEventListener('input', syncSaveButton);
    }
    syncSaveButton();
  };
  const enhanceAnnotationEditing = () => {
    const popup = document.querySelector('.remarq-popup');
    if (!(popup instanceof HTMLElement)) return;
    const addTextarea = popup.querySelector('textarea[placeholder="请输入原型标注说明…"]');
    if (addTextarea instanceof HTMLTextAreaElement) {
      keepEnterAsNewline(addTextarea);
      const hint = popup.querySelector('.remarq-popup-hint');
      if (hint instanceof HTMLElement) hint.textContent = 'Enter 换行 · 点击“保存标注”保存';
      configureAddActions(popup, addTextarea);
    }
    const editTextarea = popup.querySelector('.remarq-popup-edit-textarea');
    const existingActions = popup.querySelector('.quickpage-remarq-edit-actions');
    if (!(editTextarea instanceof HTMLTextAreaElement)) {
      existingActions?.remove();
      return;
    }
    keepEnterAsNewline(editTextarea);
    if (existingActions) return;
    const actions = document.createElement('div');
    actions.className = 'quickpage-remarq-edit-actions';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'quickpage-remarq-save-btn';
    saveButton.textContent = '保存标注';
    saveButton.addEventListener('mousedown', (event) => event.preventDefault());
    saveButton.addEventListener('click', () => {
      // The component commits edits through its existing blur handler. Reusing
      // it preserves storage, history and marker updates.
      editTextarea.blur();
      requestAnimationFrame(() => actions.remove());
    });
    actions.appendChild(saveButton);
    editTextarea.insertAdjacentElement('afterend', actions);
  };
  const enforceReadOnlyPopup = () => {
    if (!readOnly) return;
    const popup = document.querySelector('.remarq-popup');
    if (!(popup instanceof HTMLElement)) return;
    popup.querySelector('.remarq-popup-edit-textarea')?.replaceWith(
      Object.assign(document.createElement('div'), { textContent: currentAnnotation()?.comment || '' }),
    );
    popup.querySelectorAll('.remarq-popup-actions button').forEach((button) => {
      const label = button.textContent?.trim();
      if (!['Copy', 'Close'].includes(label || '')) button.remove();
    });
    popup.querySelector('.remarq-popup-actions-row--transitions')?.remove();
    popup.querySelector('.quickpage-remarq-edit-actions')?.remove();
  };
  const enhanceAddPopup = () => {
    if (!channel || !(selectedElementForDraft instanceof HTMLElement)) return;
    const popup = document.querySelector('.remarq-popup');
    const textarea = popup?.querySelector('textarea[placeholder="请输入原型标注说明…"]');
    const body = popup?.querySelector('.remarq-popup-body');
    if (!(popup instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement) ||
        !(body instanceof HTMLElement) || popup.querySelector('.quickpage-remarq-popup-ai')) return;
    configureAddActions(popup, textarea);

    const panel = document.createElement('div');
    panel.className = 'quickpage-remarq-popup-ai';
    const directionTitle = document.createElement('div');
    directionTitle.className = 'quickpage-remarq-popup-ai-label';
    directionTitle.textContent = '重点标注方向';
    const directionHint = document.createElement('div');
    directionHint.className = 'quickpage-remarq-popup-ai-hint';
    directionHint.textContent = '不选择时由 AI 根据所选元素自行判断，也可以选择一个或多个关注方向。';
    const directionGrid = document.createElement('div');
    directionGrid.className = 'quickpage-remarq-direction-grid';
    const directionInputs = annotationDirectionOptions.map((option) => {
      const optionLabel = document.createElement('label');
      optionLabel.className = 'quickpage-remarq-direction';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = option.value;
      const text = document.createElement('span');
      text.textContent = option.label;
      optionLabel.append(checkbox, text);
      directionGrid.appendChild(optionLabel);
      return checkbox;
    });
    const instructionLabel = document.createElement('label');
    instructionLabel.className = 'quickpage-remarq-popup-ai-label';
    instructionLabel.textContent = '补充要求';
    const instruction = document.createElement('textarea');
    instruction.className = 'quickpage-remarq-ai-instruction';
    instruction.maxLength = 800;
    instruction.placeholder = '补充关注方向或说明，例如：重点说明推荐条件、展示频率和关闭规则';
    instruction.setAttribute('aria-label', 'AI 标注补充说明与方向');
    instruction.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.stopPropagation();
    });
    const generateButton = document.createElement('button');
    generateButton.type = 'button';
    generateButton.className = 'quickpage-remarq-generate-btn';
    generateButton.textContent = 'AI 生成原型标注';
    const supplementButton = document.createElement('button');
    supplementButton.type = 'button';
    supplementButton.className = 'quickpage-remarq-generate-btn';
    supplementButton.textContent = '帮我确认补充';
    const generateActions = document.createElement('div');
    generateActions.className = 'quickpage-remarq-generate-actions';
    generateActions.append(generateButton, supplementButton);
    let aiRequestPending = false;
    const syncSupplementButton = () => {
      supplementButton.disabled = aiRequestPending ||
        !textarea.value.trim() || !textarea.value.includes('待确认');
    };
    textarea.addEventListener('input', syncSupplementButton);
    syncSupplementButton();
    const status = document.createElement('div');
    status.className = 'quickpage-remarq-ai-status';
    status.setAttribute('aria-live', 'polite');
    generateButton.addEventListener('click', async () => {
      const selectedElement = selectedElementForDraft;
      if (!(selectedElement instanceof HTMLElement)) return;
      aiRequestPending = true;
      generateButton.disabled = true;
      syncSupplementButton();
      generateButton.textContent = 'AI 生成中...';
      status.dataset.error = 'false';
      status.textContent = '正在结合项目、页面和所选元素生成标注';
      try {
        const existingAnnotations = globalThis.WebRemarq.getAnnotations(route()).map((item) => ({
          comment: item.comment,
          fingerprint: item.fingerprint,
        }));
        const result = await post('generateElementDraft', {
          candidate: makeCandidate(selectedElement, 'selected'),
          existingAnnotations,
          directions: directionInputs.filter((input) => input.checked).map((input) => input.value),
          instruction: instruction.value.trim(),
        });
        if (typeof result !== 'string' || !result.trim()) throw new Error('AI 未返回有效标注');
        textarea.value = result.trim();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        status.textContent = 'AI 标注已填入，请检查后点击“保存标注”';
      } catch (error) {
        status.dataset.error = 'true';
        status.textContent = error instanceof Error ? error.message : 'AI 标注生成失败，请重试';
      } finally {
        aiRequestPending = false;
        generateButton.disabled = false;
        syncSupplementButton();
        generateButton.textContent = 'AI 生成原型标注';
        requestAnimationFrame(fitRemarqPopup);
      }
    });
    supplementButton.addEventListener('click', async () => {
      const selectedElement = selectedElementForDraft;
      const comment = textarea.value.trim();
      if (!(selectedElement instanceof HTMLElement)) return;
      if (!comment) {
        status.dataset.error = 'true';
        status.textContent = '请先生成或输入原型标注，再确认补充';
        return;
      }
      aiRequestPending = true;
      syncSupplementButton();
      generateButton.disabled = true;
      supplementButton.textContent = 'AI 确认中...';
      status.dataset.error = 'false';
      status.textContent = '正在确认草稿中的待确认项并补充规则';
      try {
        const selectedDirections = directionInputs
          .filter((input) => input.checked)
          .map((input) => input.value);
        const additionalInstruction = [
          selectedDirections.length ? '重点标注方向：' + selectedDirections.join('、') : '',
          instruction.value.trim(),
        ].filter(Boolean).join('\\n');
        const result = await post('supplementElementDraft', {
          annotation: {
            comment,
            fingerprint: fingerprint(selectedElement),
            route: route(),
            viewport: { width: innerWidth, height: innerHeight },
          },
          focusAreas: [],
          instruction: additionalInstruction,
        });
        if (typeof result !== 'string' || !result.trim()) throw new Error('AI 未返回有效补充标注');
        textarea.value = result.trim();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        status.textContent = 'AI 已确认补充，请检查后点击“保存标注”';
      } catch (error) {
        status.dataset.error = 'true';
        status.textContent = error instanceof Error ? error.message : 'AI 确认补充失败，请重试';
      } finally {
        aiRequestPending = false;
        syncSupplementButton();
        generateButton.disabled = false;
        supplementButton.textContent = '帮我确认补充';
        requestAnimationFrame(fitRemarqPopup);
      }
    });
    panel.append(
      directionTitle,
      directionHint,
      directionGrid,
      instructionLabel,
      instruction,
      generateActions,
      status,
    );
    body.appendChild(panel);
    requestAnimationFrame(fitRemarqPopup);
  };
  document.addEventListener('click', (event) => {
    const target = event.target;
    const inspectedElement = pendingInspectedElement;
    pendingInspectedElement = null;
    if (!(target instanceof HTMLElement) || inspectedElement !== target) return;
    const textarea = document.querySelector('.remarq-popup textarea[placeholder="请输入原型标注说明…"]');
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    selectedElementForDraft = target;
    enhanceAddPopup();
    requestAnimationFrame(() => {
      const inspectButton = document.querySelector('[data-remarq-action="inspect"]');
      if (textarea.isConnected && inspectButton instanceof HTMLElement &&
          !inspectButton.classList.contains('remarq-active')) inspectButton.click();
    });
  }, true);
  document.addEventListener('click', (event) => {
    if (!readOnly) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const popup = target.closest('.remarq-popup');
    if (!popup) return;
    const button = target.closest('button');
    if (button) {
      if (['Copy', 'Close'].includes(button.textContent?.trim() || '')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (target.closest('.remarq-popup-header, .remarq-popup-history')) return;
    // Stop the detail text's built-in click-to-edit handler.
    if (target.closest('.remarq-popup-body')) event.stopImmediatePropagation();
  }, true);

  let activeDetailAnnotationId = '';
  const qualityScoreLabels = {
    clear: '清晰',
    ambiguous: '存在歧义',
    unactionable: '不可执行',
  };
  const qualityInput = (annotation) => ({
    comment: annotation.comment,
    fingerprint: annotation.fingerprint,
    route: annotation.route,
    viewport: annotation.viewport,
  });
  const currentAnnotation = () =>
    globalThis.WebRemarq.getAnnotations().find((item) => item.id === activeDetailAnnotationId);
  const replaceAnnotation = async (annotationId, changes) => {
    const annotations = globalThis.WebRemarq.getAnnotations();
    const current = annotations.find((item) => item.id === annotationId);
    if (!current) throw new Error('当前标注不存在或已被删除');
    const updated = { ...current, ...changes };
    Object.entries(changes).forEach(([key, value]) => {
      if (value === undefined) delete updated[key];
    });
    const file = new File(
      [JSON.stringify({ version: 1, annotations: annotations.map((item) =>
        item.id === annotationId ? updated : item
      ) })],
      'updated-annotations.json',
      { type: 'application/json' },
    );
    await globalThis.WebRemarq.import(file);
    const saved = globalThis.WebRemarq.getAnnotations().find((item) => item.id === annotationId);
    if (!saved) throw new Error('标注保存后未能重新读取');
    for (const [key, value] of Object.entries(changes)) {
      const matches = value === undefined
        ? saved[key] === undefined
        : JSON.stringify(saved[key]) === JSON.stringify(value);
      if (!matches) throw new Error('标注保存校验失败，请重试');
    }
    return saved;
  };
  const appendQualityList = (panel, title, items) => {
    if (!Array.isArray(items) || !items.length) return;
    const section = document.createElement('div');
    section.className = 'quickpage-remarq-quality-section';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const list = document.createElement('ul');
    items.forEach((item) => {
      const entry = document.createElement('li');
      entry.textContent = String(item);
      list.appendChild(entry);
    });
    section.append(heading, list);
    panel.appendChild(section);
  };
  const closeDetailPopup = (popup) => {
    const closeButton = Array.from(popup.querySelectorAll('.remarq-popup-utility-btn'))
      .find((button) => ['Close', '关闭'].includes(button.textContent?.trim() || ''));
    if (closeButton instanceof HTMLElement) closeButton.click();
  };
  const showSupplementDraft = (panel, popup, annotation, draft) => {
    panel.replaceChildren();
    const title = document.createElement('div');
    title.className = 'quickpage-remarq-quality-title';
    title.textContent = 'AI 确认补充稿';
    const hint = document.createElement('div');
    hint.className = 'quickpage-remarq-popup-ai-hint';
    hint.textContent = 'AI 已结合业务和当前终端确认待定项。请检查内容；只有点击“保存补充”后才会替换原标注。';
    const textarea = document.createElement('textarea');
    textarea.className = 'quickpage-remarq-quality-draft';
    textarea.value = draft;
    textarea.setAttribute('aria-label', 'AI 补充标注草稿');
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.stopPropagation();
    });
    const actions = document.createElement('div');
    actions.className = 'quickpage-remarq-quality-actions';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'quickpage-remarq-quality-btn';
    cancelButton.textContent = '取消';
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'quickpage-remarq-quality-btn quickpage-remarq-quality-btn--primary';
    saveButton.textContent = '保存补充';
    const status = document.createElement('div');
    status.className = 'quickpage-remarq-quality-status';
    status.setAttribute('aria-live', 'polite');
    cancelButton.addEventListener('click', () => renderManualQualityPanel(panel, popup, annotation));
    saveButton.addEventListener('click', async () => {
      const comment = textarea.value.trim();
      if (!comment) {
        status.dataset.error = 'true';
        status.textContent = '补充标注不能为空';
        return;
      }
      const latest = currentAnnotation();
      if (!latest) return;
      saveButton.disabled = true;
      cancelButton.disabled = true;
      status.dataset.error = 'false';
      status.textContent = '正在保存补充标注';
      try {
        const saved = await replaceAnnotation(latest.id, { comment, qualityCheck: undefined });
        const marker = document.querySelector('.remarq-marker[data-annotation-id="' + saved.id + '"]');
        if (marker instanceof HTMLElement) marker.title = comment;
        closeDetailPopup(popup);
      } catch (error) {
        status.dataset.error = 'true';
        status.textContent = error instanceof Error ? error.message : '补充标注保存失败，请重试';
        saveButton.disabled = false;
        cancelButton.disabled = false;
      }
    });
    actions.append(cancelButton, saveButton);
    panel.append(title, hint, textarea, actions, status);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    requestAnimationFrame(fitRemarqPopup);
  };
  const showQualityConfirmationOptions = (panel, popup, annotation) => {
    panel.replaceChildren();
    const title = document.createElement('div');
    title.className = 'quickpage-remarq-quality-title';
    title.textContent = '确认补充方向';
    const hint = document.createElement('div');
    hint.className = 'quickpage-remarq-popup-ai-hint';
    hint.textContent = 'AI 只处理质检中的待确认项；如需额外复核某类规则，可按需勾选补充方向。';
    const optionGrid = document.createElement('div');
    optionGrid.className = 'quickpage-remarq-confirm-grid';
    const optionInputs = qualityConfirmationOptions.map((option) => {
      const label = document.createElement('label');
      label.className = 'quickpage-remarq-confirm-option';
      label.title = option.prompt;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = option.value;
      checkbox.checked = false;
      const text = document.createElement('span');
      text.textContent = option.label;
      label.append(checkbox, text);
      optionGrid.appendChild(label);
      return checkbox;
    });
    const instructionLabel = document.createElement('label');
    instructionLabel.className = 'quickpage-remarq-popup-ai-label';
    instructionLabel.textContent = '其他补充要求';
    const instruction = document.createElement('textarea');
    instruction.className = 'quickpage-remarq-confirm-instruction';
    instruction.maxLength = 800;
    instruction.placeholder = '例如：每组默认展示 6 个，超过后换行并支持展开全部';
    instruction.setAttribute('aria-label', '确认补充的其他要求');
    instruction.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.stopPropagation();
    });
    const actions = document.createElement('div');
    actions.className = 'quickpage-remarq-quality-actions';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'quickpage-remarq-quality-btn';
    cancelButton.textContent = '取消';
    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'quickpage-remarq-quality-btn quickpage-remarq-quality-btn--primary';
    confirmButton.textContent = '开始确认补充';
    const status = document.createElement('div');
    status.className = 'quickpage-remarq-quality-status';
    status.setAttribute('aria-live', 'polite');
    cancelButton.addEventListener('click', () => renderManualQualityPanel(panel, popup, annotation));
    confirmButton.addEventListener('click', async () => {
      const latest = currentAnnotation();
      if (!latest?.qualityCheck) return;
      confirmButton.disabled = true;
      cancelButton.disabled = true;
      optionInputs.forEach((input) => { input.disabled = true; });
      instruction.disabled = true;
      status.dataset.error = 'false';
      status.textContent = 'AI 正在结合业务、终端和所选方向确认补充';
      try {
        const draft = await post('supplementQuality', {
          annotation: qualityInput(latest),
          qualityCheck: latest.qualityCheck,
          focusAreas: optionInputs.filter((input) => input.checked).map((input) => input.value),
          instruction: instruction.value.trim(),
        });
        if (typeof draft !== 'string' || !draft.trim()) throw new Error('AI 未返回有效补充标注');
        showSupplementDraft(panel, popup, latest, draft.trim());
      } catch (error) {
        status.dataset.error = 'true';
        status.textContent = error instanceof Error ? error.message : 'AI 确认补充失败，请重试';
        confirmButton.disabled = false;
        cancelButton.disabled = false;
        optionInputs.forEach((input) => { input.disabled = false; });
        instruction.disabled = false;
      }
      requestAnimationFrame(fitRemarqPopup);
    });
    actions.append(cancelButton, confirmButton);
    panel.append(title, hint, optionGrid, instructionLabel, instruction, actions, status);
    requestAnimationFrame(fitRemarqPopup);
  };
  function renderManualQualityPanel(panel, popup, annotation) {
    panel.replaceChildren();
    panel.dataset.comment = annotation.comment;
    const check = annotation.qualityCheck;
    const head = document.createElement('div');
    head.className = 'quickpage-remarq-quality-head';
    const title = document.createElement('div');
    title.className = 'quickpage-remarq-quality-title';
    title.textContent = 'AI 标注质检';
    head.appendChild(title);
    if (check) {
      const score = document.createElement('span');
      score.className = 'quickpage-remarq-quality-score';
      score.dataset.score = check.score;
      score.textContent = qualityScoreLabels[check.score] || check.score;
      head.appendChild(score);
    }
    panel.appendChild(head);
    if (check) {
      appendQualityList(panel, '发现的问题', check.issues);
      appendQualityList(panel, '待确认事项', check.clarifyingQuestions);
      if (!check.issues?.length && !check.clarifyingQuestions?.length) {
        const clearText = document.createElement('div');
        clearText.className = 'quickpage-remarq-popup-ai-hint';
        clearText.textContent = '当前标注表达清晰，未发现需要补充的问题。';
        panel.appendChild(clearText);
      }
    } else {
      const hint = document.createElement('div');
      hint.className = 'quickpage-remarq-popup-ai-hint';
      hint.textContent = '质检不会自动运行，需要时手动调用。';
      panel.appendChild(hint);
    }
    const actions = document.createElement('div');
    actions.className = 'quickpage-remarq-quality-actions';
    const checkButton = document.createElement('button');
    checkButton.type = 'button';
    checkButton.className = 'quickpage-remarq-quality-btn';
    checkButton.textContent = check ? '重新 AI 质检' : 'AI 质检';
    actions.appendChild(checkButton);
    const supplementButton = document.createElement('button');
    if (check) {
      supplementButton.type = 'button';
      supplementButton.className = 'quickpage-remarq-quality-btn quickpage-remarq-quality-btn--primary';
      supplementButton.textContent = '帮我确认补充';
      actions.appendChild(supplementButton);
    }
    const status = document.createElement('div');
    status.className = 'quickpage-remarq-quality-status';
    status.setAttribute('aria-live', 'polite');
    checkButton.addEventListener('click', async () => {
      const latest = currentAnnotation();
      if (!latest) return;
      checkButton.disabled = true;
      if (check) supplementButton.disabled = true;
      status.dataset.error = 'false';
      status.textContent = 'AI 正在检查当前标注';
      try {
        const result = await post('quality', qualityInput(latest));
        if (!result || typeof result !== 'object') throw new Error('AI 未返回有效质检结果');
        const saved = await replaceAnnotation(latest.id, { qualityCheck: result });
        renderManualQualityPanel(panel, popup, saved);
      } catch (error) {
        status.dataset.error = 'true';
        status.textContent = error instanceof Error ? error.message : 'AI 质检失败，请重试';
        checkButton.disabled = false;
        if (check) supplementButton.disabled = false;
      }
      requestAnimationFrame(fitRemarqPopup);
    });
    if (check) {
      supplementButton.addEventListener('click', () => {
        const latest = currentAnnotation();
        if (!latest?.qualityCheck) return;
        showQualityConfirmationOptions(panel, popup, latest);
      });
    }
    panel.append(actions, status);
  }
  const enhanceDetailPopup = () => {
    if (!channel || !activeDetailAnnotationId) return;
    const popup = document.querySelector('.remarq-popup');
    const body = popup?.querySelector('.remarq-popup-body');
    if (!(popup instanceof HTMLElement) || !(body instanceof HTMLElement) ||
        popup.querySelector('textarea[placeholder="请输入原型标注说明…"]')) return;
    const annotation = currentAnnotation();
    if (!annotation) return;
    popup.querySelector('.remarq-popup-quality')?.remove();
    const existing = popup.querySelector('.quickpage-remarq-quality');
    if (existing instanceof HTMLElement && existing.dataset.annotationId === annotation.id) {
      if (existing.dataset.comment !== annotation.comment) {
        const previousPanelComment = existing.dataset.comment || '';
        existing.dataset.comment = annotation.comment;
        if (annotation.qualityCheck && existing.dataset.qualityResetPending !== 'true') {
          existing.dataset.qualityResetPending = 'true';
          void replaceAnnotation(annotation.id, { qualityCheck: undefined })
            .then((saved) => {
              if (existing.isConnected) renderManualQualityPanel(existing, popup, saved);
            })
            .catch(() => {
              existing.dataset.comment = previousPanelComment;
            })
            .finally(() => { delete existing.dataset.qualityResetPending; });
        } else {
          renderManualQualityPanel(existing, popup, annotation);
        }
      }
      return;
    }
    existing?.remove();
    const panel = document.createElement('div');
    panel.className = 'quickpage-remarq-quality';
    panel.dataset.annotationId = annotation.id;
    const history = body.querySelector('.remarq-popup-history');
    body.insertBefore(panel, history);
    renderManualQualityPanel(panel, popup, annotation);
    requestAnimationFrame(fitRemarqPopup);
  };
  document.addEventListener('click', (event) => {
    const target = event.target;
    const trigger = target instanceof Element
      ? target.closest('.remarq-marker[data-annotation-id], .remarq-quality-bubble[data-annotation-id]')
      : null;
    if (!(trigger instanceof HTMLElement)) return;
    activeDetailAnnotationId = trigger.dataset.annotationId || '';
    requestAnimationFrame(enhanceDetailPopup);
  }, true);
  if (channel) {
    const toolbar = document.querySelector('.remarq-toolbar');
    if (toolbar instanceof HTMLElement) {
      toolbar.classList.add('quickpage-remarq-toolbar');
      const aiTools = document.createElement('div');
      aiTools.className = 'quickpage-remarq-ai-tools';
      const makeAIButton = (kind, label, icon) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quickpage-remarq-ai-btn';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.innerHTML = icon + '<span>' + label + '</span>';
        button.addEventListener('click', () => void post(kind).catch(() => {}));
        return button;
      };
      aiTools.append(
        makeAIButton(
          'annotatePage',
          'AI 一键标注页面',
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.6 4.4L6 9l4.4 1.6L12 15l1.6-4.4L18 9l-4.4-1.6L12 3Z"/><path d="m5 15-.8 2.2L2 18l2.2.8L5 21l.8-2.2L8 18l-2.2-.8L5 15Z"/><path d="m19 14-1 2.8-3 1.2 3 1.2 1 2.8 1-2.8 3-1.2-3-1.2-1-2.8Z"/></svg>',
        ),
      );
      toolbar.appendChild(aiTools);
    }
  }
  const clearButton = document.querySelector('[data-remarq-action="clear"]');
  if (clearButton instanceof HTMLElement) {
    clearButton.title = '清理当前页标注';
    clearButton.setAttribute('aria-label', '清理当前页标注');
  }
  let clearConfirmed = false;
  document.addEventListener('click', async (event) => {
    const target = event.target;
    const button = target instanceof Element ? target.closest('[data-remarq-action="clear"]') : null;
    if (!button) return;
    if (clearConfirmed) {
      clearConfirmed = false;
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const confirmed = channel
      ? await post('confirmClear')
      : globalThis.confirm(
          '确认清除当前页面全部标注？\\n\\n此操作会清除当前页面所有的原型标注信息，且不可撤销。',
        );
    if (!confirmed) return;
    clearConfirmed = true;
    setTimeout(() => button.click(), 0);
  }, true);
  const fitRemarqPopup = () => {
    const popup = document.querySelector('.remarq-popup');
    if (!(popup instanceof HTMLElement)) return;
    const rect = popup.getBoundingClientRect();
    const margin = 12;
    let left = Number.parseFloat(popup.style.left) || rect.left + scrollX;
    let top = Number.parseFloat(popup.style.top) || rect.top + scrollY;
    if (rect.right > innerWidth - margin) left -= rect.right - (innerWidth - margin);
    if (rect.left < margin) left += margin - rect.left;
    if (rect.bottom > innerHeight - margin) top -= rect.bottom - (innerHeight - margin);
    if (rect.top < margin) top += margin - rect.top;
    popup.style.left = Math.max(scrollX + margin, left) + 'px';
    popup.style.top = Math.max(scrollY + margin, top) + 'px';
  };
  const popupObserver = new MutationObserver((changes) => {
    if (changes.some((change) => change.addedNodes.length || change.removedNodes.length)) {
      requestAnimationFrame(() => {
        fitRemarqPopup();
        if (readOnly) enforceReadOnlyPopup();
        else {
          enhanceAnnotationEditing();
          enhanceDetailPopup();
        }
      });
    }
  });
  popupObserver.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', () => requestAnimationFrame(() => {
    if (readOnly) enforceReadOnlyPopup();
    else enhanceAnnotationEditing();
  }), true);
  addEventListener('resize', fitRemarqPopup);
  if (channel) {
    parent.postMessage({ source: 'quickpage-remarq-ready', channel }, '*');
  }
  if (${config.autoInspect ? 'true' : 'false'}) {
    requestAnimationFrame(() => {
      document.querySelector('[data-remarq-action="inspect"]')?.click();
    });
  }
})();
</script>`
}

export function buildRemarqPreviewHtml(
  html: string,
  store: AnnotationStore | undefined,
  options: { channel: string; theme: 'light' | 'dark' },
): string {
  const scripts = `<script>${safeScript(localizedWebRemarqRuntime)}</script>${bootstrapScript({
    store: store ?? EMPTY_ANNOTATION_STORE,
    channel: options.channel,
    theme: options.theme,
    autoInspect: true,
  })}`
  return injectBeforeBodyEnd(html, scripts)
}

export function buildRemarqExportHtml(
  html: string,
  store: AnnotationStore | undefined,
  options: { storageKey: string; theme: 'light' | 'dark' },
): string {
  const scripts = `<script>${safeScript(localizedWebRemarqRuntime)}</script>${bootstrapScript({
    store: store ?? EMPTY_ANNOTATION_STORE,
    storageKey: options.storageKey,
    theme: options.theme,
    readOnly: true,
  })}`
  return injectBeforeBodyEnd(html, scripts)
}
