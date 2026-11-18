const DB_NAME = 'quickpage-export-directories'
const STORE_NAME = 'directories'
const memoryHandles = new Map<string, FileSystemDirectoryHandle>()
const permissionStates = new Map<string, PermissionState>()

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法保存导出目录'))
  })
}

async function readStoredHandle(projectId: string): Promise<FileSystemDirectoryHandle | null> {
  const memory = memoryHandles.get(projectId)
  if (memory) return memory
  try {
    const db = await openDatabase()
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(projectId)
      request.onsuccess = () =>
        resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null)
      request.onerror = () => reject(request.error)
    })
    db.close()
    if (handle) {
      memoryHandles.set(projectId, handle)
      permissionStates.set(projectId, await handle.queryPermission({ mode: 'readwrite' }))
    }
    return handle
  } catch {
    return null
  }
}

async function storeHandle(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  memoryHandles.set(projectId, handle)
  try {
    const db = await openDatabase()
    await new Promise<void>((resolve, reject) => {
      const request = db
        .transaction(STORE_NAME, 'readwrite')
        .objectStore(STORE_NAME)
        .put(handle, projectId)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    db.close()
  } catch {
    // The current session can still reuse the handle when persistence is unavailable.
  }
}

function requireDirectoryPicker(): void {
  if (!window.showDirectoryPicker)
    throw new Error('当前浏览器不支持选择并记住保存目录，请使用最新版 Chrome 或 Edge')
}

export async function getExportDirectoryName(projectId: string): Promise<string> {
  return (await readStoredHandle(projectId))?.name ?? ''
}

export async function chooseExportDirectory(projectId: string): Promise<FileSystemDirectoryHandle> {
  requireDirectoryPicker()
  // Invoke the picker before any asynchronous storage read so browser user activation is preserved.
  const previous = memoryHandles.get(projectId)
  const handle = await window.showDirectoryPicker({
    id: 'quickpage-export',
    mode: 'readwrite',
    startIn: previous ?? 'downloads',
  })
  // The picker itself grants access. Avoid a second permission prompt that may be
  // blocked after the picker resolves and leave the export waiting indefinitely.
  memoryHandles.set(projectId, handle)
  permissionStates.set(projectId, 'granted')
  await storeHandle(projectId, handle)
  return handle
}

export async function ensureExportDirectory(projectId: string): Promise<FileSystemDirectoryHandle> {
  requireDirectoryPicker()
  const handle = memoryHandles.get(projectId)
  if (handle && permissionStates.get(projectId) === 'granted') return handle
  // Do not await permission queries here: this function is called from the export
  // click, and the directory picker must run while that user activation is active.
  return chooseExportDirectory(projectId)
}

export async function writeExportFile(
  root: FileSystemDirectoryHandle,
  path: readonly string[],
  content: Blob | string,
): Promise<void> {
  if (!path.length || path.some((segment) => !segment || segment === '.' || segment === '..'))
    throw new Error('导出文件路径无效')
  let directory = root
  for (const segment of path.slice(0, -1))
    directory = await directory.getDirectoryHandle(segment, { create: true })
  const file = await directory.getFileHandle(path.at(-1)!, { create: true })
  const writable = await file.createWritable()
  await writable.write(content)
  await writable.close()
}

export function isDirectorySelectionCanceled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
