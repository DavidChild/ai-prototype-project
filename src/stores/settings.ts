import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ModelRef, ModelSelection, ProviderConfig } from '@/types/provider'
import { saasApi } from '@/services/saas'

export interface GenParams {
  /** 批量生成并发数 1–5 */
  concurrency: number
  /** 页面生成 max_tokens */
  maxTokens: number
  temperature: number
  tailwindCdnUrl: string
  /** 需求理解输入 token 预算 */
  analysisInputBudget: number
}

const DEFAULT_GEN_PARAMS: GenParams = {
  concurrency: 3,
  maxTokens: 16000,
  temperature: 0.7,
  tailwindCdnUrl: 'https://cdn.tailwindcss.com',
  analysisInputBudget: 24000,
}

const STORAGE_KEY = 'quickpage:settings'

interface PersistedSettings {
  providers: ProviderConfig[]
  modelSelection: ModelSelection
  genParams: GenParams
  securityNoticeAcknowledged: boolean
  appTheme: 'dark' | 'light'
}

function loadPersisted(): Partial<PersistedSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<PersistedSettings>) : {}
  } catch {
    return {}
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const saved = loadPersisted()

  const providers = ref<ProviderConfig[]>(saved.providers ?? [])
  const modelSelection = ref<ModelSelection>(
    saved.modelSelection ?? { analysis: null, generation: null },
  )
  const genParams = ref<GenParams>({ ...DEFAULT_GEN_PARAMS, ...saved.genParams })
  const securityNoticeAcknowledged = ref(saved.securityNoticeAcknowledged ?? false)
  const appTheme = ref<'dark' | 'light'>(saved.appTheme ?? 'dark')
  const remoteLoaded = ref(false)
  const allowedModels = ref<string[]>([])
  const allowedPresetModels = ref<Record<string,string[]>>({})
  const loadedTenantId = ref<string | null>(null)
  let loadingRemote: Promise<void> | null = null

  watch(
    [providers, modelSelection, genParams, securityNoticeAcknowledged, appTheme],
    () => {
      const data: PersistedSettings = {
        providers: [],
        modelSelection: { analysis: null, generation: null },
        genParams: genParams.value,
        securityNoticeAcknowledged: securityNoticeAcknowledged.value,
        appTheme: appTheme.value,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    },
    { deep: true },
  )

  function toggleAppTheme(): void {
    appTheme.value = appTheme.value === 'dark' ? 'light' : 'dark'
  }

  function getProvider(id: string): ProviderConfig | undefined {
    return providers.value.find((p) => p.id === id)
  }

  async function loadTenantConfig(force = false, tenantId?: string): Promise<void> {
    if (tenantId && loadedTenantId.value !== tenantId) force = true
    if (remoteLoaded.value && !force) return
    if (loadingRemote && !force) return loadingRemote
    loadingRemote = saasApi.aiConfig().then((config) => {
      providers.value = config.providers
      modelSelection.value = config.modelSelection
      allowedModels.value = config.allowedModels
      allowedPresetModels.value = config.allowedPresetModels
      remoteLoaded.value = true
      loadedTenantId.value = tenantId ?? loadedTenantId.value
      const legacyProviders = saved.providers ?? []
      if (!config.providers.some((provider) => provider.source === 'tenant') && legacyProviders.length && config.allowedModels.length) {
        const migratable = legacyProviders.map((provider) => ({ ...provider, models: provider.models.filter((model) => config.allowedModels.includes(model)) })).filter((provider) => provider.models.length)
        return Promise.all(migratable.map((provider) => saasApi.saveAiProvider(provider)))
          .then(() => saved.modelSelection ? saasApi.saveAiSelection(saved.modelSelection) : undefined)
          .then(() => saasApi.aiConfig())
          .then((migrated) => { providers.value = migrated.providers; modelSelection.value = migrated.modelSelection; allowedModels.value = migrated.allowedModels; allowedPresetModels.value = migrated.allowedPresetModels })
      }
    }).finally(() => { loadingRemote = null })
    return loadingRemote
  }

  async function upsertProvider(provider: ProviderConfig): Promise<void> {
    await saasApi.saveAiProvider(provider)
    await loadTenantConfig(true)
  }

  async function removeProvider(id: string): Promise<void> {
    await saasApi.removeAiProvider(id)
    await loadTenantConfig(true)
  }

  async function saveModelSelection(): Promise<void> {
    await saasApi.saveAiSelection(modelSelection.value)
  }

  /** 解析某用途最终生效的 provider+model（项目级覆盖优先） */
  function resolveModel(
    kind: keyof ModelSelection,
    override?: Partial<ModelSelection>,
  ): { provider: ProviderConfig; model: string } | null {
    const mref: ModelRef | null | undefined = override?.[kind] ?? modelSelection.value[kind]
    if (!mref) return null
    const provider = getProvider(mref.providerId)
    if (!provider || (!provider.apiKey && !provider.managed)) return null
    return { provider, model: mref.model }
  }

  return {
    providers,
    modelSelection,
    genParams,
    securityNoticeAcknowledged,
    appTheme,
    toggleAppTheme,
    getProvider,
    upsertProvider,
    removeProvider,
    resolveModel,
    loadTenantConfig,
    saveModelSelection,
    remoteLoaded,
    loadedTenantId,
    allowedModels,
    allowedPresetModels,
  }
})
