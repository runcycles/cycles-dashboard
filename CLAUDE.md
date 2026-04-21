## Git Rules — STRICT
- ALWAYS use native git for ALL commits and pushes
- NEVER use mcp__github__ tools for committing or pushing
- Use mcp__github__ ONLY for: PRs, Issues, GitHub Actions
- Write commit messages to a temp file, then: `git commit -F <file>`
- NEVER use --no-gpg-sign flag

# Cycles strict rules
- yaml API specs always the authority
- always update AUDIT.md files when making changes to server, admin, client repos
- maintain at least 95% or higher test coverage for all code repos

# Cycles Dashboard

Vue 3 + TypeScript admin dashboard for the Cycles governance admin API. See
[`README.md`](README.md) for the feature overview and [`OPERATIONS.md`](OPERATIONS.md)
for the production runbook.

## Conformance target

The dashboard tracks a specific admin spec version. The current target is
recorded in `README.md` (spec badge) and mirrored in `AUDIT.md`. Any changes
that depend on new admin API surface must:

1. Update the spec-version badge in `README.md`.
2. Add an entry in `CHANGELOG.md` (downstream release notes).
3. Update `AUDIT.md` (engineering narrative) — this is a strict repo rule.

## Stack notes

- Vue 3 + Vite + TypeScript (strict mode is already inherited via
  `@vue/tsconfig`). Typecheck must stay clean; do not disable strict mode.
- Tests via Vitest. Keep line coverage ≥ 95% per the strict rule above.
- No backend code lives here — all API calls target `cycles-server-admin`.
  Wire-contract changes belong in that repo, not here.
