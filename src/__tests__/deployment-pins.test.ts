import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const EXPECTED = {
  'cycles-server': '0.1.25.58',
  'cycles-server-admin': '0.1.25.53',
  'cycles-server-events': '0.1.25.24',
} as const

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('published server deployment pins', () => {
  it('pins the patch dashboard image in production Compose and the README example', () => {
    for (const file of ['docker-compose.prod.yml', 'README.md']) {
      expect(source(file)).toContain('ghcr.io/runcycles/cycles-dashboard:0.1.25.76')
      expect(source(file)).not.toMatch(/ghcr\.io\/runcycles\/cycles-dashboard:(?:latest|main)\b/)
    }
    expect(JSON.parse(source('package.json')).version).toBe('0.1.25.76')
    expect(JSON.parse(source('package-lock.json')).version).toBe('0.1.25.76')
  })

  it.each(['docker-compose.yml', 'docker-compose.prod.yml', 'README.md'])(
    '%s uses the reviewed exact server fleet',
    (file) => {
      const text = source(file)
      for (const [image, version] of Object.entries(EXPECTED)) {
        expect(text).toContain(`ghcr.io/runcycles/${image}:${version}`)
        expect(text).not.toMatch(new RegExp(`ghcr\\.io/runcycles/${image}:(?:latest|main)\\b`))
      }
    },
  )

  it('documents the rollout-sensitive events upgrade and ordered fleet rollout', () => {
    const operations = source('OPERATIONS.md')
    expect(operations).toContain('runtime `0.1.25.58`, admin')
    expect(operations).toContain('`evidence:processing`')
    expect(operations).toContain('Upgrade events before')
  })
})
