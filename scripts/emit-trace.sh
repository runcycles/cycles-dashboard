#!/usr/bin/env bash
# Emit a traced admin request so you can exercise the v0.1.25.39
# trace_id cross-surface correlation feature end-to-end without
# clicking through DevTools to find a trace id first.
#
# Usage:
#   ./scripts/emit-trace.sh                    # POST a createTenant with a fresh trace
#   ./scripts/emit-trace.sh --reuse abc123...  # replay with a known trace id
#   ./scripts/emit-trace.sh --op list-tenants  # GET /tenants instead (no write)
#
# What it does:
#   1. Mints a random 32-hex trace id (or uses --reuse) and a 16-hex
#      span id, constructs a W3C-compliant `traceparent` header, and
#      sends an admin-plane request.
#   2. Reads `X-Cycles-Trace-Id` from the response (server echoes the
#      inbound trace id per v0.1.25.28 precedence: traceparent →
#      X-Cycles-Trace-Id → server-generated).
#   3. Prints the trace id + deep-link URLs for AuditView / EventsView
#      so you can paste one into the browser and see the chip + pivot
#      flow against the row you just created.
#
# Defaults assume the local compose stack (admin on :7979, dashboard
# dev server on :5173). Override via env:
#   ADMIN_URL=http://localhost:7979
#   DASHBOARD_URL=http://localhost:5173
#   ADMIN_API_KEY=admin-key

set -euo pipefail

ADMIN_URL="${ADMIN_URL:-http://localhost:7979}"
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:5173}"
ADMIN_KEY="${ADMIN_API_KEY:-admin-key}"

op="create-tenant"
reuse_trace=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --reuse) reuse_trace="$2"; shift 2 ;;
        --op) op="$2"; shift 2 ;;
        -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done

# Mint 32-hex trace id + 16-hex span id. `openssl rand -hex` works on
# macOS, Linux, and Git-Bash on Windows — unlike /dev/urandom + xxd
# which behaves differently across those three.
if [[ -n "$reuse_trace" ]]; then
    if [[ ! "$reuse_trace" =~ ^[0-9a-f]{32}$ ]]; then
        echo "error: --reuse must be 32 lowercase hex chars, got: $reuse_trace" >&2
        exit 2
    fi
    trace_id="$reuse_trace"
else
    trace_id=$(openssl rand -hex 16)
fi
span_id=$(openssl rand -hex 8)
traceparent="00-${trace_id}-${span_id}-01"

# Response headers land in a temp file — `curl -D` is portable across
# the three shells above; `grep -i` tolerates the header-case mismatch
# some stacks surface (Spring emits `X-Cycles-Trace-Id` exactly, nginx
# passthrough preserves it).
hdr_file=$(mktemp)
trap 'rm -f "$hdr_file"' EXIT

case "$op" in
    create-tenant)
        # Unique tenant_id so reruns don't 409. Trace id is already
        # unique per invocation — reuse its first 12 chars as the
        # suffix so you can eyeball the link between the tenant and
        # the trace in AuditView.
        tenant_id="trace-${trace_id:0:12}"
        body=$(cat <<EOF
{"tenant_id":"$tenant_id","name":"Trace probe $(date +%H%M%S)"}
EOF
)
        echo ">> POST $ADMIN_URL/v1/admin/tenants  tenant_id=$tenant_id"
        curl -sS -D "$hdr_file" -o /dev/null \
            -X POST \
            -H "X-Admin-API-Key: $ADMIN_KEY" \
            -H "Content-Type: application/json" \
            -H "traceparent: $traceparent" \
            -d "$body" \
            "$ADMIN_URL/v1/admin/tenants"
        ;;
    list-tenants)
        echo ">> GET  $ADMIN_URL/v1/admin/tenants?limit=5"
        curl -sS -D "$hdr_file" -o /dev/null \
            -H "X-Admin-API-Key: $ADMIN_KEY" \
            -H "traceparent: $traceparent" \
            "$ADMIN_URL/v1/admin/tenants?limit=5"
        ;;
    *)
        echo "unknown --op: $op (supported: create-tenant, list-tenants)" >&2
        exit 2
        ;;
esac

echoed_trace=$(grep -i '^X-Cycles-Trace-Id:' "$hdr_file" | awk '{print $2}' | tr -d '\r')

echo
echo "supplied trace_id: $trace_id"
echo "server echoed   : ${echoed_trace:-<none>}"

if [[ -z "$echoed_trace" ]]; then
    echo "warning: server did not echo X-Cycles-Trace-Id — verify admin is v0.1.25.31+" >&2
elif [[ "$echoed_trace" != "$trace_id" ]]; then
    echo "warning: echoed trace id does not match supplied — inbound traceparent may not be honored" >&2
fi

echo
echo "Deep-link URLs (paste in browser):"
echo "  audit:  $DASHBOARD_URL/audit?trace_id=$trace_id"
echo "  events: $DASHBOARD_URL/events?trace_id=$trace_id"
