import type { ImageOrigin, ParsedDocument } from '@/types/parsing'

/** 持久化的源文档（解析后的文本与元信息，不存原始文件） */
export interface SourceDoc {
  id: string
  projectId: string
  fileName: string
  fileType: ParsedDocument['fileType']
  text: string
  meta: ParsedDocument['meta']
}

/** 从文档中提取的图片资产 */
export interface StoredAsset {
  id: string
  projectId: string
  docId: string
  mimeType: string
  blob: Blob
  origin: ImageOrigin
}

async function storageRequest<T>(action: string, input: unknown = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api/storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, input }),
    })
  } catch {
    throw new Error('无法连接 MySQL 存储服务，请确认本地服务已启动')
  }
  let payload: { ok: boolean; result?: T; error?: string }
  try {
    payload = await response.json()
  } catch {
    throw new Error('MySQL 存储接口不可用，请通过 npm run dev 或 npm run preview 启动应用')
  }
  if (!response.ok || !payload.ok) throw new Error(payload.error || 'MySQL 存储服务不可用')
  return payload.result as T
}

export { storageRequest }
