import type { AnnotationStore } from 'web-remarq'
import type { Platform, StyleSpec } from './project'

export type ShareAccess = 'public' | 'expiring' | 'tenant'
export type ShareScope = 'single' | 'selected' | 'search' | 'iteration' | 'project'

export interface PrototypeShareSummary {
  id: string
  code: string
  projectId: string
  title: string
  access: ShareAccess
  scope: ShareScope
  includeAnnotations: boolean
  expiresAt?: number
  status: 'active' | 'revoked'
  viewCount: number
  createdAt: number
}

export interface SharedProject {
  id: string
  familyId: string
  name: string
  iteration: string
  platform: Platform
  styleSpec: StyleSpec
  updatedAt: number
}

export interface SharedPage {
  id: string
  projectId: string
  spec: {
    id: string
    name: string
    parentId?: string
    groupOnly?: boolean
  }
  sortOrder: number
  updatedAt: number
  html?: string
  annotationStore?: AnnotationStore
}

export interface SharedIteration {
  project: SharedProject
  pages: SharedPage[]
}

export interface PrototypeSharePayload extends PrototypeShareSummary {
  tenantName: string
  revision: number
  iterations: SharedIteration[]
}

