export type IterationPlatform = 'pc' | 'mobile'

export interface IterationRelatedPage {
  projectId: string
  projectName: string
  iteration: string
  platform: IterationPlatform
  pageId: string
  pageName: string
  description: string
  blocks: string[]
}

export interface IterationEndpointContext {
  projectId: string
  projectName: string
  iteration: string
  platform: IterationPlatform
  productName?: string
  overview?: string
  targetUsers?: string
  layout?: string
  declaredNature?: string
  purpose?: string
  pages: IterationRelatedPage[]
}

export interface IterationPlanChange {
  action: 'update' | 'create'
  sourcePageId?: string
  parentSourcePageId?: string
  name: string
  description: string
  blocks: string[]
  reason: string
  relatedPageIds: string[]
}

export interface IterationPlan {
  productNature: string
  summary: string
  changes: IterationPlanChange[]
}

export interface IterationRequirementDocument {
  fileName: string
  fileType: 'docx' | 'pdf' | 'xlsx' | 'md' | 'txt' | 'image'
  text: string
  meta: {
    pageCount?: number
    sheetNames?: string[]
    truncated?: boolean
    warnings?: string[]
  }
}

export interface IterationRequirement {
  text: string
  documentNames: string[]
  sourceProjectId: string
  sourceIteration: string
  productNature?: string
  relatedPages: IterationRelatedPage[]
  planSummary: string
  createdAt: number
}

export interface PageIterationChange {
  action: 'update' | 'create'
  reason: string
  relatedPageIds: string[]
}

export interface CopyIterationRequirementInput {
  text: string
  documents: IterationRequirementDocument[]
  relatedPages: IterationRelatedPage[]
  plan: IterationPlan
}
