<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const STORAGE_KEY = 'quickpage:page-sidebar-width'
const DEFAULT_WIDTH = 260
const MIN_WIDTH = 220
const preferredWidth = ref(DEFAULT_WIDTH)
const maxWidth = ref(520)
const width = computed(() => Math.min(maxWidth.value, Math.max(MIN_WIDTH, preferredWidth.value)))
const sidebar = ref<HTMLElement | null>(null)
const dragging = ref(false)
let observer: ResizeObserver | undefined
let drag: { element: HTMLElement; pointerId: number; startX: number; startWidth: number } | null =
  null

try {
  const saved = Number(localStorage.getItem(STORAGE_KEY))
  if (Number.isFinite(saved) && saved >= MIN_WIDTH) preferredWidth.value = Math.min(520, saved)
} catch {
  /* Resizing still works when storage is unavailable. */
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, String(preferredWidth.value))
  } catch {
    /* Best effort. */
  }
}
function setWidth(value: number) {
  preferredWidth.value = Math.round(Math.min(maxWidth.value, Math.max(MIN_WIDTH, value)))
}
function startResize(event: PointerEvent) {
  if (event.button !== 0 || drag) return
  event.preventDefault()
  const element = event.currentTarget as HTMLElement
  element.focus()
  element.setPointerCapture(event.pointerId)
  drag = { element, pointerId: event.pointerId, startX: event.clientX, startWidth: width.value }
  dragging.value = true
}
function resize(event: PointerEvent) {
  if (drag?.pointerId !== event.pointerId) return
  setWidth(drag.startWidth + event.clientX - drag.startX)
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
function resetWidth() {
  setWidth(DEFAULT_WIDTH)
  persist()
}
function onKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') setWidth(MIN_WIDTH)
  else if (event.key === 'End') setWidth(maxWidth.value)
  else setWidth(width.value + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10))
  persist()
}
onMounted(() => {
  const parent = sidebar.value?.parentElement
  if (!parent) return
  const measure = () => {
    // Reserve the 330px inspector and at least 320px for the preview.
    maxWidth.value = Math.max(MIN_WIDTH, Math.min(520, parent.clientWidth - 330 - 320 - 6))
  }
  observer = new ResizeObserver(measure)
  observer.observe(parent)
  measure()
})
onBeforeUnmount(() => {
  stopResize()
  observer?.disconnect()
})
</script>

<template>
  <aside id="page-sidebar" ref="sidebar" class="page-sidebar" :style="{ width: `${width}px` }">
    <slot />
  </aside>
  <div
    class="sidebar-resizer"
    :class="{ dragging }"
    role="separator"
    tabindex="0"
    aria-orientation="vertical"
    aria-label="调整页面树宽度"
    aria-controls="page-sidebar"
    :aria-valuemin="MIN_WIDTH"
    :aria-valuemax="maxWidth"
    :aria-valuenow="width"
    title="左右拖动调整宽度，双击恢复默认；方向键微调"
    @pointerdown="startResize"
    @pointermove="resize"
    @pointerup="stopResize"
    @pointercancel="stopResize"
    @lostpointercapture="stopResize"
    @keydown="onKeydown"
    @dblclick="resetWidth"
  />
  <Teleport to="body">
    <div v-if="dragging" class="resize-shield" aria-hidden="true" />
  </Teleport>
</template>

<style scoped>
.page-sidebar {
  flex-shrink: 0;
  min-width: 0;
  overflow: hidden;
}
.sidebar-resizer {
  flex: 0 0 6px;
  cursor: col-resize;
  touch-action: none;
  position: relative;
  background: transparent;
  outline: none;
}
.sidebar-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 1px;
  background: var(--qp-border);
}
.sidebar-resizer:hover::after,
.sidebar-resizer:focus-visible::after,
.sidebar-resizer.dragging::after {
  width: 3px;
  left: 1px;
  background: #818cf8;
}
.resize-shield {
  position: fixed;
  inset: 0;
  z-index: 99999;
  cursor: col-resize;
  user-select: none;
}
</style>
