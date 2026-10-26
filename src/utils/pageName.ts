/** Return a version-labelled, human-readable page name that is unique in the project. */
export function uniquePageName(
  requestedName: string,
  existingNames: Iterable<string>,
  versionLabel = 'v1.0',
  currentName?: string,
): string {
  const baseName = requestedName.trim() || '新页面'
  const normalizedCurrent = currentName?.trim().toLocaleLowerCase()
  const used = new Set(
    [...existingNames]
      .map((name) => name.trim().toLocaleLowerCase())
      .filter((name) => name && name !== normalizedCurrent),
  )
  const label = versionLabel.trim() || 'v1.0'
  const suffix = ` ${label}`
  const versionedName = baseName.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase())
    ? baseName
    : `${baseName}${suffix}`
  if (!used.has(versionedName.toLocaleLowerCase())) return versionedName
  for (let duplicate = 2; ; duplicate++) {
    const candidate = `${versionedName} ${duplicate}`
    if (!used.has(candidate.toLocaleLowerCase())) return candidate
  }
}
