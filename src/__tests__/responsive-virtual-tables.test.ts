import { describe, expect, it } from 'vitest'

describe('virtualized list tables — responsive scroll ownership', () => {
  it.each([
    ['EventsView.vue', '800px', 'sortedEvents.length'],
    ['BudgetsView.vue', '1210px', 'sortedBudgets.length'],
    ['ReservationsView.vue', '1240px', 'sortedReservations.length'],
    ['TenantsView.vue', '980px', 'sortedTenants.length'],
    ['ApiKeysView.vue', '1400px', 'sortedKeys.length'],
    ['AuditView.vue', '900px', 'sortedEntries.length'],
    ['WebhookDetailView.vue', '882px', 'sortedDeliveries.length'],
  ])('%s keeps its wide canvas row-only and its states viewport-width', async (file, managedWidth, rows) => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const source = readFileSync(resolve(process.cwd(), 'src/views', file), 'utf8')

    expect(source).toContain('overflow-x-auto overflow-y-hidden')
    expect(source).toContain('overflow-y-auto overflow-x-hidden')
    expect(source).toContain(managedWidth)
    expect(source).toContain('wide-table-canvas')
    expect(source).toContain('responsive-table-state')

    const wideCanvas = source.indexOf('wide-table-canvas')
    const rowGate = source.indexOf(`v-if="${rows} > 0"`, wideCanvas)
    const responsiveState = source.indexOf('responsive-table-state', rowGate)
    expect(wideCanvas).toBeGreaterThan(-1)
    expect(rowGate).toBeGreaterThan(-1)
    expect(rowGate).toBeGreaterThan(wideCanvas)
    expect(responsiveState).toBeGreaterThan(rowGate)
  })
})
