import type { PageConstraints } from './generationConstraint'
import type { PageIterationChange } from './iteration'

export interface PageReferenceDesign {
  name: string
  mimeType: string
  /** JSON-safe image data so page copies and project iterations retain the reference. */
  base64: string
  width?: number
  height?: number
  mode: 'exact' | 'faithful' | 'creative'
  /** In exact mode only, map colors and light/dark tone to the current project. */
  useProjectTone?: boolean
  /** Layout/detail freedom only. Project colors and visual language remain fixed. */
  innovation: number
}

export type PageGenerationMode = 'current' | 'from-import' | 'smart-related'

export interface PageImportReference {
  /** References Page.id rather than PageSpec.id so iteration copies can remap it safely. */
  pageId: string
  access: 'readonly' | 'editable'
  /** Restrictive rules applied when the imported page is authorized for AI edits. */
  modificationRules?: PageImportModificationRules
}

export interface PageImportModificationRules {
  /** Always preserve the existing page framework and DOM skeleton. */
  preserveFramework: boolean
  /** Always preserve the existing navigation/menu structure. */
  preserveNavigation: boolean
  /** Prefer extending the existing page instead of replacing its content. */
  onlyExtendExisting: boolean
  /** Allow adding modal, drawer, toast or onboarding overlays. */
  allowOverlays: boolean
  /** Allow changing existing copy and example data. */
  allowContentChanges: boolean
  /** Allow visual-only adjustments such as color, spacing and typography. */
  allowStyleChanges: boolean
  /** Allow adding new business sections inside the existing framework. */
  allowNewSections: boolean
  /** Allow deleting existing sections. Disabled by default. */
  allowDeleteSections: boolean
  /** Additional natural-language requirements for this imported page. */
  requirements: string
}

export const DEFAULT_PAGE_IMPORT_MODIFICATION_RULES: PageImportModificationRules = {
  preserveFramework: true,
  preserveNavigation: true,
  onlyExtendExisting: true,
  allowOverlays: true,
  allowContentChanges: true,
  allowStyleChanges: false,
  allowNewSections: false,
  allowDeleteSections: false,
  requirements: '',
}

export function normalizePageImportModificationRules(
  rules?: Partial<PageImportModificationRules>,
): PageImportModificationRules {
  return {
    ...DEFAULT_PAGE_IMPORT_MODIFICATION_RULES,
    ...rules,
    preserveFramework: true,
    preserveNavigation: true,
    requirements:
      typeof rules?.requirements === 'string' ? rules.requirements.trim().slice(0, 2000) : '',
  }
}

export interface PageSpec {
  id: string
  name: string
  /** 上级菜单的 PageSpec.id；为空表示自身是一级菜单 */
  parentId?: string
  /** 仅作为导航分组，不生成页面 */
  groupOnly?: boolean
  description: string
  blocks: string[]
  referenceDesign?: PageReferenceDesign
  constraints?: PageConstraints
  /** Existing prototype pages supplied to AI as business-flow context. */
  importedPages?: PageImportReference[]
  generationMode?: PageGenerationMode
  /** One-time AI action used to initialize a copied project iteration. */
  iterationChange?: PageIterationChange
}

export interface RequirementAnalysis {
  productName: string
  overview: string
  targetUsers?: string
  /** 页面树的扁平清单：parentId 为空的是一级菜单；支持工作台调整为多级 */
  pages: PageSpec[]
}
