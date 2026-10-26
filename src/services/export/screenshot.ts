import { toBlob } from 'html-to-image'
import type { Platform } from '@/types/project'
import { downloadBlob } from '@/utils/download'
import { CANVAS_HEIGHT, CANVAS_WIDTH, withExportIframe } from './exportFrame'

const MAX_EXPORT_HEIGHT = 10000

export async function exportPagePng(
  html: string,
  platform: Platform,
  fileName: string,
  backgroundColor = '#ffffff',
): Promise<void> {
  downloadBlob(await buildPagePng(html, platform, backgroundColor), fileName)
}

export async function buildPagePng(
  html: string,
  platform: Platform,
  backgroundColor = '#ffffff',
): Promise<Blob> {
  return withExportIframe(html, platform, async (doc, iframe) => {
    const width = CANVAS_WIDTH[platform]
    const height = Math.min(
      MAX_EXPORT_HEIGHT,
      Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, CANVAS_HEIGHT[platform]),
    )
    iframe.style.height = `${height}px`
    await new Promise((r) => setTimeout(r, 80))
    const blob = await toBlob(doc.documentElement, {
      width,
      height,
      pixelRatio: 2,
      backgroundColor,
    })
    if (!blob) throw new Error('截图生成失败')
    return blob
  })
}
