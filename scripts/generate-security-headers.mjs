import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CSP_HASH_PLACEHOLDER = '__CSP_IMPORTMAP_HASH__'

function isAsciiWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f'
}

function isTagNameBoundary(char) {
  return char === undefined || char === '>' || char === '/' || isAsciiWhitespace(char)
}

function findTagStart(html, tagName, start, closing = false) {
  const prefix = closing ? '</' : '<'
  let cursor = start
  while (cursor < html.length) {
    const tagStart = html.indexOf(prefix, cursor)
    if (tagStart === -1) return -1
    const nameStart = tagStart + prefix.length
    const nameEnd = nameStart + tagName.length
    if (
      html.slice(nameStart, nameEnd).toLowerCase() === tagName
      && isTagNameBoundary(html[nameEnd])
    ) return tagStart
    cursor = nameStart
  }
  return -1
}

function findTagEnd(html, start) {
  let quote = ''
  for (let index = start; index < html.length; index += 1) {
    const char = html[index]
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return index
    }
  }
  return -1
}

function readAttribute(attributes, wantedName) {
  let index = 0
  while (index < attributes.length) {
    while (isAsciiWhitespace(attributes[index]) || attributes[index] === '/') index += 1
    const nameStart = index
    while (
      index < attributes.length
      && !isAsciiWhitespace(attributes[index])
      && attributes[index] !== '='
      && attributes[index] !== '/'
    ) index += 1

    if (nameStart === index) {
      index += 1
      continue
    }

    const name = attributes.slice(nameStart, index).toLowerCase()
    while (isAsciiWhitespace(attributes[index])) index += 1

    let value = ''
    if (attributes[index] === '=') {
      index += 1
      while (isAsciiWhitespace(attributes[index])) index += 1
      const quote = attributes[index]
      if (quote === '"' || quote === "'") {
        index += 1
        const valueStart = index
        while (index < attributes.length && attributes[index] !== quote) index += 1
        value = attributes.slice(valueStart, index)
        if (index < attributes.length) index += 1
      } else {
        const valueStart = index
        while (index < attributes.length && !isAsciiWhitespace(attributes[index])) index += 1
        value = attributes.slice(valueStart, index)
      }
    }

    if (name === wantedName) return value
  }
  return undefined
}

function findInlineImportMaps(indexHtml) {
  const importMaps = []
  let cursor = 0

  while (cursor < indexHtml.length) {
    const openStart = findTagStart(indexHtml, 'script', cursor)
    if (openStart === -1) break

    const openNameEnd = openStart + '<script'.length
    const openEnd = findTagEnd(indexHtml, openNameEnd)
    if (openEnd === -1) throw new Error('Unterminated script opening tag')

    const attributes = indexHtml.slice(openNameEnd, openEnd)
    const contentStart = openEnd + 1
    const closeStart = findTagStart(indexHtml, 'script', contentStart, true)
    if (closeStart === -1) throw new Error('Unterminated script element')

    const closeEnd = findTagEnd(indexHtml, closeStart + '</script'.length)
    if (closeEnd === -1) throw new Error('Unterminated script closing tag')

    if (readAttribute(attributes, 'type')?.toLowerCase() === 'importmap') {
      importMaps.push(indexHtml.slice(contentStart, closeStart))
    }
    cursor = closeEnd + 1
  }

  return importMaps
}

export function renderSecurityHeaders(indexHtml, headerTemplate) {
  const importMaps = findInlineImportMaps(indexHtml)

  if (importMaps.length !== 1) {
    throw new Error(`Expected exactly one inline import map, found ${importMaps.length}`)
  }

  const importMapContent = importMaps[0]
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
