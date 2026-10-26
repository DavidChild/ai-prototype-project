<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const STORAGE_KEY = 'quickpage:inspector-panel-layout'
const DEFAULT_WIDTH = 330
const MIN_WIDTH = 280
const MAX_WIDTH = 760
const MIN_CANVAS_WIDTH = 320

const preferredWidth = ref(DEFAULT_WIDTH)
const maxWidth = ref(MAX_WIDTH)
const locked = ref(false)
const docked = ref(true)
const dragging = ref(false)
const panel = ref<HTMLElement | null>(null)
const width = computed(() => Math.min(maxWidth.value, Math.max(MIN_WIDTH, preferredWidth.value)))

let observer: ResizeObserver | undefined
let drag: { element: HTMLElement; pointerId: number; startX: number; startWidth: number } | null =
  null

try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as {
    width?: unknown
    locked?: unknown
    docked?: unknown
  } | null
  if (saved) {
    const savedWidth = Number(saved.width)
    if (Number.isFinite(savedWidth) && savedWidth >= MIN_WIDTH)
      preferredWidth.value = Math.min(MAX_WIDTH, savedWidth)
    if (typeof saved.locked === 'boolean') locked.value = saved.locked
    if (typeof saved.docked === 'boolean') docked.value = saved.docked
  }
} catch {
  /* Resizing still works when storage is unavailable or contains invalid data. */
}

function persist() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ width: preferredWidth.value, locked: locked.value, docked: docked.value }),
    )
  } catch {
    /* Best effort. */
  }
}

function setWidth(value: number, manual = false) {
  preferredWidth.value = Math.round(Math.min(maxWidth.value, Math.max(MIN_WIDTH, value)))
  if (manual) docked.value = false
}

function startResize(event: PointerEvent) {
  if (locked.value || event.button !== 0 || drag) return
  event.preventDefault()
  const element = event.currentTarget as HTMLElement
  element.focus()
  element.setPointerCapture(event.pointerId)
  drag = { element, pointerId: event.pointerId, startX: event.clientX, startWidth: width.value }
  dragging.value = true
}

function resize(event: PointerEvent) {
  if (drag?.pointerId !== event.pointerId) return
  setWidth(drag.startWidth + drag.startX - event.clientX, true)
}

function stopResize(event?: PointerEvent) {
  if (!drag || (event && event.pointerId !== drag.pointerId)) return
  const previous = drag
  drag = null
  dragging.value = false
  if (previous.element.hasPointerCapture(previous.pointerId))
    previous.element.releasePointerCapture(previous.pointerId)
  persist()
}

function dock() {
  setWidth(DEFAULT_WIDTH)
  docked.value = true
  persist()
}

function toggleLock() {
  if (drag) stopResize()
  locked.value = !locked.value
  persist()
}

function onKeydown(event: KeyboardEvent) {
  if (locked.value || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') setWidth(MIN_WIDTH, true)
  else if (event.key === 'End') setWidth(maxWidth.value, true)
  else
    setWidth(
      width.value + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 40 : 10),
      true,
    )
  persist()
}

onMounted(() => {
  const parent = panel.value?.parentElement
  if (!parent) return
  const pageSidebar = parent.querySelector<HTMLElement>('#page-sidebar')
  const measure = () => {
    const leftWidth = pageSidebar?.offsetWidth ?? 220
    const available = parent.clientWidth - leftWidth - MIN_CANVAS_WIDTH - 12
    maxWidth.value = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parent.clientWidth * 0.65, available))
  }
  observer = new ResizeObserver(measure)
  observer.observe(parent)
  if (pageSidebar) observer.observe(pageSidebar)
  measure()
})

onBeforeUnmount(() => {
  stopResize()
  observer?.disconnect()
})
</script>

<template>
  <div
    class="inspector-resizer"
    :class="{ dragging, locked }"
    role="separator"
    :tabindex="locked ? -1 : 0"
    aria-orientation="vertical"
    aria-label="调整配置工作区宽度"
    aria-controls="inspector-panel"
    :aria-disabled="locked"
    :aria-valuemin="MIN_WIDTH"
    :aria-valuemax="maxWidth"
    :aria-valuenow="width"
    :title="locked ? '配置工作区宽度已锁定' : '左右拖动调整宽度，双击恢复停靠宽度；方向键微调'"
    @pointerdown="startResize"
    @pointermove="resize"
    @pointerup="stopResize"
    @pointercancel="stopResize"
    @lostpointercapture="stopResize"
    @keydown="onKeydown"
    @dblclick="dock"
  />
  <aside
    id="inspector-panel"
    ref="panel"
    class="inspector-panel"
    :class="{ 'is-locked': locked, 'is-docked': docked }"
    :style="{ width: `${width}px` }"
  >
    <div class="inspector-controls">
      <n-tooltip>
        <template #trigger>
          <n-button
            size="tiny"
            quaternary
            :type="docked ? 'primary' : 'default'"
            :disabled="docked && width === DEFAULT_WIDTH"
            @click="dock"
          >
            停靠
          </n-button>
        </template>
        恢复右侧停靠宽度（{{ DEFAULT_WIDTH }}px）
      </n-tooltip>
      <n-tooltip>
        <template #trigger>
          <n-button
            size="tiny"
            quaternary
            :type="locked ? 'primary' : 'default'"
            @click="toggleLock"
          >
            {{ locked ? '已锁定' : '锁定' }}
          </n-button>
        </template>
        {{ locked ? '解除锁定后可调整工作区宽度' : '锁定当前工作区宽度' }}
      </n-tooltip>
    </div>
    <slot />
  </aside>
  <Teleport to="body">
    <div v-if="dragging" class="resize-shield" aria-hidden="true" />
  </Teleport>
</template>

<style scoped>
.inspector-panel {
  position: relative;
  flex-shrink: 0;
  min-width: 0;
  overflow: hidden;
}

.inspector-resizer {
  flex: 0 0 6px;
  cursor: col-resize;
  touch-action: none;
  position: relative;
  background: transparent;
  outline: none;
}

.inspector-resizer::after {
  content: '';
  position: absolute;
  inset: 0 auto 0 2px;
  width: 1px;
  background: var(--qp-border);
}

.inspector-resizer:hover::after,
.inspector-resizer:focus-visible::after,
.inspector-resizer.dragging::after {
  left: 1px;
  width: 3px;
  background: #818cf8;
}

.inspector-resizer.locked {
  cursor: default;
}

.inspector-resizer.locked::after {
  background: var(--qp-border);
}

.inspector-controls {
  position: absolute;
  z-index: 3;
  top: 5px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 2px;
}

.resize-shield {
  position: fixed;
  inset: 0;
  z-index: 99999;
  cursor: col-resize;
  user-select: none;
}
</style>
