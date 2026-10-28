import type { ChatMessage } from './llm'
import type {
  IterationPlan,
  IterationRelatedPage,
  IterationRequirementDocument,
} from './iteration'

export type IterationTaskStatus = 'pending' | 'running' | 'failed' | 'completed' | 'cancelled'
export type IterationTaskEndpointStatus =
  | 'pending'
  | 'planning'
  | 'planned'
  | 'created'
  | 'generating'
  | 'failed'
  | 'completed'

export interface IterationAiSession {
  /** Application-level stable conversation ID, retained across retries. */
  id: string
  providerId: string
  model: string
  continuationMode: 'history-replay'
  system: string
  messages: ChatMessage[]
  updatedAt: number
}

export interface IterationTaskImage {
  mimeType: string
  base64: string
}

export interface IterationTaskEndpoint {
  sourceProjectId: string
  sourceFamilyId: string
  projectName: string
  sourceIteration: string
  targetIteration: string
  generationProviderId: string
  generationModel: string
  status: IterationTaskEndpointStatus
  aiSession: IterationAiSession
  plan?: IterationPlan
  relatedPages?: IterationRelatedPage[]
  targetProjectId?: string
  completedPages?: number
  totalPages?: number
  error?: string
}

export interface IterationTask {
  id: string
  title: string
  status: IterationTaskStatus
  primarySourceId: string
  requirementText: string
  documents: IterationRequirementDocument[]
  images: IterationTaskImage[]
  endpoints: IterationTaskEndpoint[]
  cancelledAt?: number
  cancelMode?: 'keep-versions' | 'delete-versions'
  error?: string
  createdAt: number
  updatedAt: number
}
