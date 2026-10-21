import { ref, watch } from 'vue'
import { defineStore } from 'pinia'

const KEY = 'quickpage:selected-iterations'
export const useIterationSelectionStore = defineStore('iterationSelection', () => {
  const selected = ref<Record<string, string>>({})
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      selected.value = Object.fromEntries(
        Object.entries(saved).filter(([, id]) => typeof id === 'string'),
      )
    }
  } catch {
    /* Selection still works without local storage. */
  }
  watch(
    selected,
    (value) => {
      try {
        localStorage.setItem(KEY, JSON.stringify(value))
      } catch {
        /* Best effort. */
      }
    },
    { deep: true, flush: 'sync' },
  )
  function select(familyId: string, iterationId: string) {
    selected.value[familyId] = iterationId
  }
  return { selected, select }
})
