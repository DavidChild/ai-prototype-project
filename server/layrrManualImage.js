export const imageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])

export function imageTarget(element) {
  for (let node = element; node; node = node.parentElement) {
    const tag = node.tagName?.toLowerCase()
    if (tag === 'svg' || tag === 'img') return node
  }
  return null
}

export function imageUrl(value) {
  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('请输入完整的 http:// 或 https:// 图片地址')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('仅支持不含账号密码的 HTTP/HTTPS 图片地址')
  return url.href
}

export function validateImageFile(file) {
  if (!imageTypes.has(file.type.toLowerCase()))
    throw new Error('请选择 PNG、JPEG、GIF、WebP、AVIF、SVG 或 ICO 图片')
  if (!file.size || file.size > 2 * 1024 * 1024) throw new Error('单张图片需大于 0 且不超过 2 MB')
}

export function replaceImage(element, src, size) {
  if (element.tagName.toLowerCase() === 'img') {
    element.setAttribute('src', src)
    element.setAttribute('referrerpolicy', 'no-referrer')
    element.removeAttribute('srcset')
    element.removeAttribute('sizes')
    // Responsive picture sources must not override the replacement.
    if (element.parentElement?.tagName.toLowerCase() === 'picture')
      for (const child of Array.from(element.parentElement.children))
        if (child.tagName.toLowerCase() === 'source') child.remove()
    return element
  }
  const image = element.ownerDocument.createElement('img')
  for (const attr of element.attributes)
    if (
      ['id', 'class', 'style', 'width', 'height', 'role'].includes(attr.name) ||
      attr.name.startsWith('aria-')
    )
      image.setAttribute(attr.name, attr.value)
  image.setAttribute('src', src)
  image.setAttribute('referrerpolicy', 'no-referrer')
  image.setAttribute(
    'alt',
    element.getAttribute('aria-label') || element.querySelector('title')?.textContent || '',
  )
  for (const property of ['width', 'height'])
    if (!image.hasAttribute(property) && size?.[property] > 0)
      image.setAttribute(property, String(Math.round(size[property])))
  element.replaceWith(image)
  return image
}
