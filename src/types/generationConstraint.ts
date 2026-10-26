export interface GenerationConstraint {
  id: string
  name: string
  description: string
  html: string
  sourcePageId?: string
  sourcePageName?: string
  sourceConstraintId?: string
  updatedAt: number
}

export interface PageConstraints {
  mode: 'none' | 'custom'
  /** Independent snapshots: page edits never change the global library. */
  items: GenerationConstraint[]
}
