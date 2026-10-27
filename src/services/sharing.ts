import { storageRequest } from '@/services/storage/db'
import type {
  PrototypeSharePayload,
  PrototypeShareSummary,
  ShareAccess,
  ShareScope,
} from '@/types/share'

export const shareApi = {
  create: (input: {
    projectId: string
    access: ShareAccess
    scope: ShareScope
    includeAnnotations: boolean
    pageIds?: string[]
    expiresAt?: number
  }) => storageRequest<PrototypeShareSummary>('share.create', input),
  list: (projectId: string) =>
    storageRequest<PrototypeShareSummary[]>('share.list', { projectId }),
  revoke: (projectId: string, id: string) =>
    storageRequest<void>('share.revoke', { projectId, id }),
  resolve: (code: string, trackView = true) =>
    storageRequest<PrototypeSharePayload>('share.resolve', { code, trackView }),
}

