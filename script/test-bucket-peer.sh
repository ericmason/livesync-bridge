#!/usr/bin/env bash
# Integration test for the bucket (S3/MinIO journal-sync) peer.
#
# Proves interop against the plugin's own code paths (via seed_test_bucket.ts):
#   round 1: plugin-side seed  -> bridge pulls -> files appear on disk
#   round 2: plugin-side edits -> bridge pulls increments (edit/add/delete)
#   round 3: bridge restarted in "sync" mode; a file written to the storage dir
#            is packed+uploaded, then verified by a fresh plugin-side replica.
#
# Requires: docker (for MinIO), deno.
set -euo pipefail
cd "$(dirname "$0")/.."

MINIO_NAME=lsb-test-minio
MINIO_PORT=19000
TESTDIR=./dat-test
BRIDGE_PID=""
MINIO_PID=""

export TEST_ENDPOINT="http://127.0.0.1:${MINIO_PORT}"
export TEST_REGION="us-east-1"
export TEST_ACCESS_KEY="testadmin"
export TEST_SECRET_KEY="testadmin123"
export TEST_BUCKET="lsb-test-vault"
export TEST_PASSPHRASE="test-e2ee-passphrase"
export TEST_OBFUSCATE_PASSPHRASE="test-obfuscate-passphrase"

log() { echo "[test] $*"; }
fail() { echo "[test] FAIL: $*" >&2; [ -f "$TESTDIR/bridge.log" ] && tail -40 "$TESTDIR/bridge.log" >&2; exit 1; }

cleanup() {
    [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null || true
    if [ -n "$MINIO_PID" ]; then
        kill "$MINIO_PID" 2>/dev/null || true
    else
        docker rm -f "$MINIO_NAME" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

wait_for() { # wait_for <seconds> <description> <command...>
    local timeout=$1 desc=$2; shift 2
    local waited=0
    until "$@" >/dev/null 2>&1; do
        sleep 1
        waited=$((waited + 1))
        [ "$waited" -ge "$timeout" ] && fail "timeout waiting for: $desc"
    done
    log "ok: $desc (${waited}s)"
}

file_contains() { grep -q "$2" "$1" 2>/dev/null; }
file_absent() { [ ! -e "$1" ]; }

# --- Workspace -----------------------------------------------------------
rm -rf "$TESTDIR"
mkdir -p "$TESTDIR/vault"

# --- MinIO (local binary preferred; docker fallback) ---------------------
if command -v minio >/dev/null 2>&1; then
    MINIO_ROOT_USER="$TEST_ACCESS_KEY" MINIO_ROOT_PASSWORD="$TEST_SECRET_KEY" \
        minio server "$TESTDIR/minio-data" --address ":${MINIO_PORT}" \
        >"$TESTDIR/minio.log" 2>&1 &
    MINIO_PID=$!
else
    docker rm -f "$MINIO_NAME" >/dev/null 2>&1 || true
    docker run -d --name "$MINIO_NAME" -p "${MINIO_PORT}:9000" \
        -e MINIO_ROOT_USER="$TEST_ACCESS_KEY" -e MINIO_ROOT_PASSWORD="$TEST_SECRET_KEY" \
        minio/minio server /data >/dev/null
fi
wait_for 30 "MinIO healthy" curl -sf "http://127.0.0.1:${MINIO_PORT}/minio/health/live"

# --- Round 1: seed from the plugin side, bridge pulls --------------------
log "seeding bucket via plugin code path..."
deno run -A script/seed_test_bucket.ts seed | tail -2

cat > "$TESTDIR/config.json" <<EOF
{
    "peers": [
        {
            "type": "bucket",
            "name": "bucket",
            "baseDir": "",
            "direction": "pull",
            "endpoint": "${TEST_ENDPOINT}",
            "region": "${TEST_REGION}",
            "accessKey": "${TEST_ACCESS_KEY}",
            "secretKey": "${TEST_SECRET_KEY}",
            "bucket": "${TEST_BUCKET}",
            "forcePathStyle": true,
            "passphrase": "${TEST_PASSPHRASE}",
            "obfuscatePassphrase": "${TEST_OBFUSCATE_PASSPHRASE}",
            "syncIntervalSeconds": 5,
            "localDatabase": "${TESTDIR}/bucket-db"
        },
        {
            "type": "storage",
            "name": "storage",
            "baseDir": "${TESTDIR}/vault/",
            "scanOfflineChanges": false
        }
    ]
}
EOF

log "starting bridge (pull mode)..."
LSB_CONFIG="$TESTDIR/config.json" LSB_HEALTH_FILE="$TESTDIR/health.json" \
    deno run -A main.ts --reset >"$TESTDIR/bridge.log" 2>&1 &
BRIDGE_PID=$!

wait_for 90 "hello.md pulled" file_contains "$TESTDIR/vault/notes/hello.md" "This came from the seeder"
wait_for 30 "unicode filename pulled" test -f "$TESTDIR/vault/notes/日本語ノート.md"
wait_for 30 "nested file pulled" file_contains "$TESTDIR/vault/deep/nested/dir/leaf.md" "Deeply nested"
wait_for 30 "binary file pulled" test -f "$TESTDIR/vault/binary.bin"
wait_for 30 "big file pulled" file_contains "$TESTDIR/vault/notes/big.md" "lazy dog"
# Binary content must be byte-exact.
python3 - "$TESTDIR/vault/binary.bin" <<'PYEOF' || fail "binary content mismatch"
import sys
expected = bytes([0, 1, 2, 3, 250, 251, 252, 253, 254, 255])
assert open(sys.argv[1], "rb").read() == expected
PYEOF
log "ok: binary content byte-exact"

# --- Round 2: incremental edits from the plugin side ---------------------
log "running update round via plugin code path..."
deno run -A script/seed_test_bucket.ts update | tail -2

wait_for 60 "edited content pulled" file_contains "$TESTDIR/vault/notes/hello.md" "Modified by the second seeder"
wait_for 30 "added file pulled" file_contains "$TESTDIR/vault/added-later.md" "added in the update round"
wait_for 30 "deletion propagated" file_absent "$TESTDIR/vault/deep/nested/dir/leaf.md"

# --- Round 3: bidirectional (bridge writes back) -------------------------
log "restarting bridge in sync mode (no --reset: persistence must carry over)..."
kill "$BRIDGE_PID"; wait "$BRIDGE_PID" 2>/dev/null || true
python3 - "$TESTDIR/config.json" <<'PYEOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c["peers"][0]["direction"] = "sync"
json.dump(c, open(p, "w"), indent=2)
PYEOF

LSB_CONFIG="$TESTDIR/config.json" LSB_HEALTH_FILE="$TESTDIR/health.json" \
    deno run -A main.ts >"$TESTDIR/bridge.log" 2>&1 &
BRIDGE_PID=$!
# Let the bridge finish its startup sync before creating the local change.
wait_for 60 "bridge watching after restart" grep -q "\[bucket\]" "$TESTDIR/bridge.log"
sleep 5

echo "Written on the bridge side at $(date)" > "$TESTDIR/vault/from-bridge.md"
log "wrote from-bridge.md into the storage dir"

check_pushed() {
    deno run -A script/seed_test_bucket.ts verify-pull 2>/dev/null | grep "^MANIFEST:" | grep -q "from-bridge.md"
}
wait_for 120 "bridge-written file visible to a fresh plugin-side replica" check_pushed

# Show the round-tripped content for the record.
deno run -A script/seed_test_bucket.ts verify-pull 2>/dev/null | grep "^MANIFEST:" \
    | sed 's/^MANIFEST://' \
    | python3 -c 'import json,sys; m=json.load(sys.stdin); print("[test] round-trip content:", repr(m.get("from-bridge.md")))'

log "ALL TESTS PASSED"
