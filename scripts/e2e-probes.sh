#!/usr/bin/env bash
# End-to-end HTTP probes against the dashboard's built-in nginx proxy.
#
# Intended to be run against a live compose stack (redis + cycles-server +
# cycles-server-admin + dashboard). Runs from CI (.github/workflows/e2e.yml)
# but safe to run locally:
#
#   ADMIN_API_KEY=admin-bootstrap-key docker compose -f docker-compose.yml up -d
#   ./scripts/e2e-probes.sh  # defaults to http://localhost:8080
#
# Purpose: catch plumbing defects in the shipped Docker image that unit
# tests and Vite-based dev work don't exercise — specifically the class
# of bugs that produced v0.1.25.22's nginx proxy_pass path-stripping
# regression. Business logic is covered by per-repo test suites; this
# script intentionally only checks status + top-level JSON shape.

set -euo pipefail

BASE="${DASHBOARD_URL:-http://localhost:8080}"
ADMIN_KEY="${ADMIN_API_KEY:-admin-bootstrap-key}"

pass=0
fail=0
failures=()

# Runs one probe: METHOD PATH "expected-json-key" [extra-curl-args...]
# "expected-json-key" may be empty for non-JSON probes (e.g. root HTML).
# Failures are collected and reported at the end rather than aborting so
# one nginx regression doesn't hide other issues.
probe() {
    local name="$1" method="$2" path="$3" expect_key="$4"
    shift 4

    local body status
    local tmpfile
    tmpfile=$(mktemp)
    status=$(curl -sS -o "$tmpfile" -w "%{http_code}" -X "$method" \
        -H "X-Admin-API-Key: $ADMIN_KEY" \
        "$@" \
        "$BASE$path" || echo "000")
    body=$(cat "$tmpfile")
    rm -f "$tmpfile"

    # Status code check. Allow the caller to pin an expected code via
    # EXPECT_STATUS=nnn; defaults to 2xx. "4xx-or-5xx" accepts any error
    # status (used for probes that care about error-body shape, not the
    # specific code).
    local expected_status="${EXPECT_STATUS:-2xx}"
    local status_ok=0
    case "$expected_status" in
        2xx)         [[ "$status" =~ ^2[0-9][0-9]$ ]] && status_ok=1 ;;
        4xx-or-5xx)  [[ "$status" =~ ^[45][0-9][0-9]$ ]] && status_ok=1 ;;
        *)           [ "$status" = "$expected_status" ] && status_ok=1 ;;
    esac

    if [ "$status_ok" != "1" ]; then
        echo "  FAIL: $name — expected $expected_status, got $status"
        echo "        body: ${body:0:200}"
        failures+=("$name: HTTP $status")
        fail=$((fail+1))
        return
    fi

    # JSON shape check (skipped if expect_key empty).
    if [ -n "$expect_key" ]; then
        if ! echo "$body" | python -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
except Exception as e:
    print(f'not valid JSON: {e}')
    sys.exit(1)
if '$expect_key' not in d:
    print(f'missing key \"$expect_key\" in response; keys={list(d.keys())[:5]}')
    sys.exit(1)
" >/dev/null 2>&1; then
            echo "  FAIL: $name — JSON did not contain key '$expect_key'"
            echo "        body: ${body:0:200}"
            failures+=("$name: missing JSON key $expect_key")
            fail=$((fail+1))
            return
        fi
    fi

    echo "  PASS: $name (HTTP $status)"
    pass=$((pass+1))
}

echo "=== E2E probes against $BASE ==="
echo

# 1. Dashboard HTML served at root — SPA entry point.
probe "dashboard serves index.html" GET / "" -H "Accept: text/html"

# 2. Admin plane: tenants list (caught the v0.1.25.22 nginx bug).
#    Request flows: curl → dashboard:80/nginx → cycles-admin:7979.
#    Before the nginx fix, nginx sent only "/v1/" to upstream and this
#    returned 500 "No static resource v1." A passing probe here is the
#    single most important regression lock.
probe "admin plane /v1/admin/tenants" GET /v1/admin/tenants tenants

# 3. Admin plane: audit logs — exercises a deeper path (/admin/audit/logs).
probe "admin plane /v1/admin/audit/logs" GET "/v1/admin/audit/logs?limit=3" logs

# 4. Runtime plane via dual-backend routing split.
#    nginx sends /v1/reservations* to cycles-server:7878, not admin.
#    This probe also exercises the spec-required tenant query param.
probe "runtime plane /v1/reservations via proxy" GET \
    "/v1/reservations?tenant=example-tenant&status=ACTIVE" reservations

# 5. Stage 3 dual-auth on webhooks (cycles-protocol#40, server v0.1.25.16).
#    Admin key on a tenant-scoped path with REQUIRED tenant query param.
probe "Stage 3 admin-on-behalf-of webhooks" GET \
    "/v1/webhooks?tenant=example-tenant" subscriptions

# 6. Unknown path returns a structured ErrorResponse, not Spring's bare
#    "No static resource" text or nginx's default HTML error page. The
#    exact status (404 vs 500) is server-implementation-dependent —
#    what matters is that the body has the `error` field from the spec's
#    ErrorResponse schema. Regression catch for the exact shape of
#    failure that hid v0.1.25.22's nginx path-stripping bug.
EXPECT_STATUS=4xx-or-5xx probe "unknown path returns ErrorResponse" GET /v1/nonexistent error
unset EXPECT_STATUS

# --- Bulk-action probes (admin v0.1.25.26+, governance spec v0.1.25.21) ---
# Exercises POST /v1/admin/{tenants,webhooks}/bulk-action through nginx
# — same plumbing concern as the admin-plane GETs above. Coverage is
# deliberately scoped to schema-validation paths + zero-match happy path
# + idempotency replay: these run safely against any seed-content state
# and don't mutate data (CI redis is fresh-per-run, but keeping probes
# mutation-free lets the same script run against dev stacks too).
# Mutation-path coverage lives in vitest (src/__tests__/idempotencyKey.test.ts)
# and in ad-hoc local smoke-tests via the PR-B matrix.

gen_uuid() { python -c 'import uuid; print(uuid.uuid4())'; }

# Probe-unique search string so the zero-match probes stay zero-match
# regardless of what seed data the admin server ships with.
BULK_NOMATCH="e2e-probe-nomatch-$$-$(date +%s)"
K_TENANT_EMPTY=$(gen_uuid)
K_TENANT_BADACT=$(gen_uuid)
K_TENANT_OK=$(gen_uuid)
K_WEBHOOK_EMPTY=$(gen_uuid)
K_WEBHOOK_OK=$(gen_uuid)

# 7. Tenant bulk-action with empty filter → 400 INVALID_REQUEST
#    (spec minProperties:1 on TenantBulkFilter).
EXPECT_STATUS=400 probe "tenant bulk-action: empty filter → 400" POST \
    /v1/admin/tenants/bulk-action error \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"SUSPEND\",\"filter\":{},\"idempotency_key\":\"$K_TENANT_EMPTY\"}"
unset EXPECT_STATUS

# 8. Tenant bulk-action with an action not in the enum → 400.
#    Catches regressions where the server silently accepts unknown
#    actions (would be a huge footgun — the dashboard's UI only offers
#    SUSPEND/REACTIVATE/CLOSE).
EXPECT_STATUS=400 probe "tenant bulk-action: invalid action → 400" POST \
    /v1/admin/tenants/bulk-action error \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"DELETE\",\"filter\":{\"status\":\"ACTIVE\"},\"idempotency_key\":\"$K_TENANT_BADACT\"}"
unset EXPECT_STATUS

# 9. Zero-match happy path — exercises the full envelope through nginx
#    without needing seed content. Asserts 200 + presence of `succeeded`
#    array (which is always in the response even when empty).
probe "tenant bulk-action: zero-match → 200 envelope" POST \
    /v1/admin/tenants/bulk-action succeeded \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"SUSPEND\",\"filter\":{\"search\":\"$BULK_NOMATCH\",\"status\":\"ACTIVE\"},\"idempotency_key\":\"$K_TENANT_OK\"}"

# 10. Idempotency replay — same key, same body within the 15-minute
#     window returns the cached envelope. We can only assert status +
#     shape via this probe; byte-for-byte envelope equality is enforced
#     in the vitest suite.
probe "tenant bulk-action: idempotency replay → 200" POST \
    /v1/admin/tenants/bulk-action succeeded \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"SUSPEND\",\"filter\":{\"search\":\"$BULK_NOMATCH\",\"status\":\"ACTIVE\"},\"idempotency_key\":\"$K_TENANT_OK\"}"

# 11. Webhook mirror: empty filter → 400.
EXPECT_STATUS=400 probe "webhook bulk-action: empty filter → 400" POST \
    /v1/admin/webhooks/bulk-action error \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"PAUSE\",\"filter\":{},\"idempotency_key\":\"$K_WEBHOOK_EMPTY\"}"
unset EXPECT_STATUS

# 12. Webhook zero-match → 200 envelope.
probe "webhook bulk-action: zero-match → 200 envelope" POST \
    /v1/admin/webhooks/bulk-action succeeded \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"PAUSE\",\"filter\":{\"search\":\"$BULK_NOMATCH\",\"status\":\"ACTIVE\"},\"idempotency_key\":\"$K_WEBHOOK_OK\"}"

echo
echo "=== $pass passed / $fail failed ==="
if [ "$fail" -gt 0 ]; then
    echo
    echo "Failures:"
    for f in "${failures[@]}"; do echo "  - $f"; done
    exit 1
fi
