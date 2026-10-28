import type { PageSpec } from './analysis'
import type { AnnotationStore } from 'web-remarq'

export type PageGenStatus = 'idle' | 'queued' | 'generating' | 'done' | 'failed'

export interface Page {
  id: string
  projectId: string
  spec: PageSpec
  sortOrder: number
  genStatus: PageGenStatus
  errorMessage?: string
  currentVersionId?: string
  /** True after the new iteration's initial AI change has been saved. */
  iterationInitialized?: boolean
  /** AI-produced version has not yet been acknowledged from the page menu. */
  reviewPending?: boolean
  /** Visual review annotations stored separately from the prototype HTML. */
  annotationStore?: AnnotationStore
  updatedAt: number
}

export type PageVersionSource =
  | 'generate'
  | 'refine'
  | 'rollback'
  | 'layrr'
  | 'ai-local'
  | 'import'
  | 'copy'

export interface PageVersion {
  id: string
  pageId: string
  versionNumber: number
  html: string
  source: PageVersionSource
  feedbackText?: string
  createdAt: number
}
