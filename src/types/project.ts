import type { RequirementAnalysis } from './analysis'
import type { ModelSelection } from './provider'
import type { GenerationConstraint } from './generationConstraint'
import type { IterationRequirement } from './iteration'

export type Platform = 'pc' | 'mobile'

export interface DesignTokens {
  primaryColor: string
  /** 辅助/强调色，可选 */
  accentColor?: string
  neutralTone: 'gray' | 'slate' | 'zinc' | 'stone' | 'neutral'
  borderRadius: 'none' | 'sm' | 'md' | 'lg' | 'full'
  fontFamily: 'system' | 'serif' | 'rounded'
  density: 'compact' | 'comfortable' | 'spacious'
  colorMode: 'light' | 'dark'
}

/** 布局容器：PC 用前 5 项，移动端用 auto + 后 3 项 */
export type LayoutMode =
  | 'auto'
  | 'side-nav'
  | 'top-nav'
  | 'mixed-nav'
  | 'none'
  | 'bottom-tab'
  | 'top-bar'
  | 'immersive'

export interface StyleSpec {
  /** 内置预设 id；'custom' 表示完全自定义风格 */
  presetId: string
  tokens: DesignTokens
  layout?: LayoutMode
  /** 布局的补充说明 */
  layoutNotes?: string
  /** presetId 为 'custom' 时的自定义风格描述 */
  customStyleText?: string
  /** 风格补充要求 */
  customNotes?: string
}

export interface ProjectEndpointProfile {
  /** Human-maintained endpoint nature; preferred over AI inference during iteration planning. */
  nature: string
  /** Business purpose, users and responsibilities of this endpoint. */
  purpose: string
}

export interface Project {
  id: string
  /** 同一项目各迭代共享的标识；id 仍是工作台的独立数据空间。 */
  familyId?: string
  iteration?: string
  basedOnId?: string
  /** Requirement and cross-platform context used to initialize this iteration. */
  iterationRequirement?: IterationRequirement
  name: string
  /** Shared by every iteration in the same project family. */
  endpointProfile?: ProjectEndpointProfile
  /** 隐藏项目仅影响项目列表展示，不删除任何内容。 */
  hidden?: boolean
  platform: Platform
  styleSpec: StyleSpec
  generationConstraints?: GenerationConstraint[]
  analysis?: RequirementAnalysis
  modelOverride?: Partial<ModelSelection>
  createdAt: number
  updatedAt: number
}
