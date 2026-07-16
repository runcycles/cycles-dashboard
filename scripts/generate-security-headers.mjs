import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CSP_HASH_PLACEHOLDER = '__CSP_IMPORTMAP_HASH__'

export function renderSecurityHeaders(indexHtml, headerTemplate) {
  const importMaps = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(([, attributes]) => /\btype\s*=\s*(["'])importmap\1/i.test(attributes))

  if (importMaps.length !== 1) {
    throw new Error(`Expected exactly one inline import map, found ${importMaps.length}`)
  }

  const importMapContent = importMaps[0][2]
  if (!importMapContent.trim()) throw new Error('Inline import map is empty')

  const placeholders = headerTemplate.split(CSP_HASH_PLACEHOLDER).length - 1
  if (placeholders !== 1) {
    throw new Error(`Expected exactly one ${CSP_HASH_PLACEHOLDER} placeholder, found ${placeholders}`)
  }

  const digest = createHash('sha256').update(importMapContent, 'utf8').digest('base64')
  const cspSource = `sha256-${digest}`
  return {
    cspSource,
    output: headerTemplate.replace(CSP_HASH_PLACEHOLDER, cspSource),
  }
}

export async function generateSecurityHeaders(indexPath, templatePath, outputPath) {
  const [indexHtml, headerTemplate] = await Promise.all([
    readFile(indexPath, 'utf8'),
    readFile(templatePath, 'utf8'),
  ])
  const rendered = renderSecurityHeaders(indexHtml, headerTemplate)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, rendered.output, 'utf8')
  return rendered.cspSource
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [, , indexPath, templatePath, outputPath] = process.argv
  if (!indexPath || !templatePath || !outputPath) {
    console.error('Usage: node scripts/generate-security-headers.mjs <index.html> <template.conf> <output.conf>')
    process.exitCode = 2
  } else {
    try {
      const cspSource = await generateSecurityHeaders(indexPath, templatePath, outputPath)
      console.log(`Generated CSP import-map source: ${cspSource}`)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
