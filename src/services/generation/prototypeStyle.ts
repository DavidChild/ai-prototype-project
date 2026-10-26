/** Extract visual style only; never execute scripts or send the whole existing page to the model. */
export function extractPrototypeStyle(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // Read the normalizer's JSON theme config as data; do not eval prototype scripts.
  let themeColors: unknown
  const config = doc.querySelector('script[data-ua-inject="config"]')?.textContent ?? ''
  const match = /^\s*tailwind\.config\s*=\s*([\s\S]*?)\s*;?\s*$/.exec(config)
  if (match?.[1] && match[1].length < 20000) {
    try {
      const parsed = JSON.parse(match[1]) as { theme?: { extend?: { colors?: unknown } } }
      themeColors = parsed?.theme?.extend?.colors
    } catch {
      /* Non-JSON custom scripts are intentionally ignored. */
    }
  }
  const css = [...doc.querySelectorAll('style')]
    .map((style) => (style.textContent ?? '').replace(/url\([^)]*\)/gi, 'url(omitted)'))
    .join('\n')
    .slice(-6000)
  const components = [
    ['page', 'body'],
    ['navigation', 'header,nav,aside'],
    ['content', 'main,section,article'],
    ['headings', 'h1,h2,h3'],
    ['controls', 'button,input,select,[role="button"]'],
    ['cards', '[class*="rounded"]'],
  ] as const
  const classes = Object.fromEntries(
    components.map(([kind, selector]) => [
      kind,
      [
        ...new Set(
          [...doc.querySelectorAll(selector)]
            .slice(0, 5)
            .map((element) => (element.getAttribute('class') ?? '').slice(0, 240))
            .filter(Boolean),
        ),
      ],
    ]),
  )
  const properties = [
    'color',
    'background',
    'background-color',
    'border-color',
    'border-radius',
    'font-family',
    'font-size',
    'font-weight',
    'box-shadow',
  ]
  const inlineStyles = [
    ...new Set(
      [...doc.querySelectorAll<HTMLElement>('[style]')]
        .slice(0, 30)
        .map((element) =>
          properties
            .map((property) => {
              const value = element.style.getPropertyValue(property)
              return value ? `${property}:${value}` : ''
            })
            .filter(Boolean)
            .join(';'),
        )
        .filter(Boolean),
    ),
  ]
    .join('\n')
    .slice(0, 2000)
  return JSON.stringify({ themeColors, css, inlineStyles, classes })
}
