#!/usr/bin/env bash
# The full pre-push gate, in the order CI runs it, so a push never learns
# something from CI that it could have learned here.
#
# Mirrors .github/workflows/ci.yml step for step: ESLint, Prettier with CI's
# own globs (not `prettier --check .`, which also flags files CI ignores), the
# test suite, both builds, the 2 MiB @require ceiling, and the bundle-sharing
# check that `npm run build` already runs.
#
# Prettier is here because agent commits skip the pre-commit hook by design
# (--no-verify), so their files reach main unformatted and CI rejects the
# push. Run from anywhere: `bash scripts/gates.sh`.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s ==\n' "$1"; }

step 'ESLint'
npx eslint src/

step 'Prettier (CI globs)'
npx prettier --check "src/**/*.js" "*.config.js" "**/*.md"

step 'Tests'
node_modules/.bin/vitest run --exclude '**/.claude/**' 2>&1 | tail -4

step 'Build: dev standalone'
BUILD_TARGET=dev-standalone npx rollup -c 2>&1 | tail -1

step 'Build: production (includes bundle-sharing check)'
BUILD_MODE=production npx rollup -c 2>&1 | tail -1
node scripts/check-bundle-sharing.mjs

step 'Bundle sizes (2097152-byte @require ceiling)'
limit=2097152
for file in dist/Toolasha.user.js dist/libraries/*.js; do
    size=$(wc -c <"$file")
    if [ "$size" -gt "$limit" ]; then
        echo "FAIL $file is over the limit ($size bytes)"
        exit 1
    fi
    echo "ok   $file ($size bytes)"
done

printf '\nAll gates passed.\n'
