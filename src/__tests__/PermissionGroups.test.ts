import { describe, it, expect } from 'vitest'
import { PERMISSIONS, PERMISSION_GROUPS } from '../types'

describe('PERMISSION_GROUPS', () => {
  // The grouped view is purely a UI concern — the flat PERMISSIONS list
  // is the canonical source and the admin server validates against its
  // own Permission enum. If the two drift, an operator either can't see
  // a new permission in the picker (groups missing it) or can pick a
  // permission the server will reject (groups has it, PERMISSIONS doesn't
  // — though this is prevented by the Set intersection check below).
  it('covers every entry in PERMISSIONS exactly once', () => {
    const flattened = PERMISSION_GROUPS.flatMap(p => p.sections.flatMap(s => s.items as readonly string[]))
    // Every flattened item must appear in PERMISSIONS.
    const allowed = new Set<string>(PERMISSIONS as readonly string[])
    for (const p of flattened) {
      expect(allowed.has(p), `grouped perm not in PERMISSIONS: ${p}`).toBe(true)
    }
    // Every PERMISSIONS entry must appear in the groups.
    const grouped = new Set(flattened)
    for (const p of PERMISSIONS) {
      expect(grouped.has(p), `PERMISSIONS entry missing from groups: ${p}`).toBe(true)
    }
    // No duplicates across groups.
    expect(flattened.length).toBe(PERMISSIONS.length)
    expect(new Set(flattened).size).toBe(flattened.length)
  })

  it('has non-empty sections', () => {
    for (const plane of PERMISSION_GROUPS) {
      expect(plane.sections.length, `plane ${plane.plane} has no sections`).toBeGreaterThan(0)
      for (const section of plane.sections) {
        expect(section.items.length, `section ${plane.plane}/${section.label} is empty`).toBeGreaterThan(0)
      }
    }
  })
})
