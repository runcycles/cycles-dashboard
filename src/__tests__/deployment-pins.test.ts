import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const EXPECTED = {
  'cycles-server': '0.1.25.61',
  'cycles-server-admin': '0.1.25.56',
  'cycles-server-events': '0.1.25.26',
} as const

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('published server deployment pins', () => {
  it('pins the patch dashboard image in production Compose and the README example', () => {
    for (const file of ['docker-compose.prod.yml', 'README.md']) {
      expect(source(file)).toContain('ghcr.io/runcycles/cycles-dashboard:0.1.25.87')
      expect(source(file)).not.toMatch(/ghcr\.io\/runcycles\/cycles-dashboard:(?:latest|main)\b/)
    }
    expect(JSON.parse(source('package.json')).version).toBe('0.1.25.87')
    expect(JSON.parse(source('package-lock.json')).version).toBe('0.1.25.87')
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
    expect(operations).toContain('runtime `0.1.25.61`, admin `0.1.25.56`')
    expect(operations).toContain('`evidence:processing`')
    const readers = operations.indexOf('up -d --wait --no-deps cycles-server cycles-events')
    const stopAdmin = operations.indexOf('stop cycles-admin', readers)
    const backup = operations.indexOf('redis-cli --rdb', stopAdmin)
    const startAdmin = operations.indexOf('up -d --wait --no-deps cycles-admin', backup)
    expect(readers).toBeGreaterThan(-1)
    expect(stopAdmin).toBeGreaterThan(readers)
    expect(backup).toBeGreaterThan(stopAdmin)
    expect(startAdmin).toBeGreaterThan(backup)
  })

  it('keeps webhook-secret and private-network escape hatches development-only', () => {
    const development = source('docker-compose.yml')
    const production = source('docker-compose.prod.yml')

    expect(development.match(/WEBHOOK_SECRET_ALLOW_PLAINTEXT: \$\{WEBHOOK_SECRET_ALLOW_PLAINTEXT:-true\}/g)).toHaveLength(2)
    expect(development).toContain(
      'WEBHOOK_URL_GUARD_ALLOW_PRIVATE_NETWORKS: ${WEBHOOK_URL_GUARD_ALLOW_PRIVATE_NETWORKS:-true}',
    )
    expect(production.match(/WEBHOOK_SECRET_ALLOW_PLAINTEXT: "false"/g)).toHaveLength(2)
    expect(production.match(/WEBHOOK_SECRET_ENCRYPTION_KEY: \$\{WEBHOOK_SECRET_ENCRYPTION_KEY:\?/g)).toHaveLength(2)
    expect(production).not.toContain('WEBHOOK_URL_GUARD_ALLOW_PRIVATE_NETWORKS')
    expect(production).not.toContain('WEBHOOK_SECRET_ENCRYPTION_REQUIRED')
  })
})
