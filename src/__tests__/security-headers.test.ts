import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { renderSecurityHeaders } from '../../scripts/generate-security-headers.mjs'

const template = `add_header Content-Security-Policy "script-src 'self' '__CSP_IMPORTMAP_HASH__'" always;`

describe('build-time CSP import-map binding', () => {
  it('hashes the exact inline import-map content and replaces the one placeholder', () => {
    const content = '{"integrity":{"/assets/lazy.js":"sha384-value"}}'
    const expected = `sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}`

    const rendered = renderSecurityHeaders(
      `<script type="importmap">${content}</script><script type="module" src="/assets/main.js"></script>`,
      template,
    )

    expect(rendered.cspSource).toBe(expected)
    expect(rendered.output).toContain(`script-src 'self' '${expected}'`)
    expect(rendered.output).not.toContain('__CSP_IMPORTMAP_HASH__')
  })

  it.each([
    ['whitespace before the delimiter', '</script >'],
    ['attributes on a malformed closing tag', '</script\t\n data-invalid>'],
  ])('accepts an import map with %s', (_, closingTag) => {
    const content = '{"integrity":{"/assets/lazy.js":"sha384-value"}}'
    const rendered = renderSecurityHeaders(
      `<script TYPE=importmap>${content}${closingTag}`,
      template,
    )

    expect(rendered.output).toContain(`'${rendered.cspSource}'`)
  })

  it('does not treat a longer element name as a script', () => {
    expect(() => renderSecurityHeaders(
      '<scripture type="importmap">{}</scripture>',
      template,
    )).toThrow(/exactly one inline import map/)
  })

  it.each([
    ['no import map', '<script type="module" src="/assets/main.js"></script>'],
    ['multiple import maps', '<script type="importmap">{}</script><script type="importmap">{}</script>'],
  ])('fails closed when the build has %s', (_, html) => {
    expect(() => renderSecurityHeaders(html, template)).toThrow(/exactly one inline import map/)
  })

  it('fails closed when the security-header template loses its placeholder', () => {
    expect(() => renderSecurityHeaders(
      '<script type="importmap">{"integrity":{}}</script>',
      'add_header Content-Security-Policy "script-src self";',
    )).toThrow(/exactly one __CSP_IMPORTMAP_HASH__ placeholder/)
  })
})
