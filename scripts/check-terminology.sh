#!/usr/bin/env bash
# Terminology gate: fail the build if legacy vocabulary
# leaks back into subkit source code.
#
# Permitted contexts (allow-list handled by path globs below):
#  - tests/fixtures (we keep historic fixtures verbatim for replay)
#  - .md docs (fine-grained wording is reviewed by hand)
#  - JSON/YAML data files and snapshot files
#  - self-healing/policy.ts explanatory comment about automation breadth
#
# Banned:
#  - "automation" in engine/sk TypeScript source outside tests/fixtures
#  - "Automation" in the generated cli-core openapi.d.ts (indicates drift)

set -euo pipefail

fail=0

# 1. "automation" must not appear in TS source outside of the allow-list.
if grep -RnE '\bautomation\b' \
  apps/engine/src apps/sk/src packages \
  --include='*.ts' --include='*.tsx' \
  --exclude-dir=tests --exclude-dir=test --exclude-dir=fixtures --exclude-dir=node_modules \
  2>/dev/null | grep -vE '(self-healing/policy\.ts)' ; then
  echo "ERROR: 'automation' still appears in engine/sk TypeScript source" >&2
  fail=1
fi

# 2. OpenAPI generated types must not carry the dead Automation schemas.
if grep -n 'Automation' packages/cli-core/src/engine-api/openapi.d.ts >/dev/null 2>&1; then
  echo "ERROR: packages/cli-core/src/engine-api/openapi.d.ts still contains 'Automation' — run 'bun run gen:openapi-client'" >&2
  fail=1
fi

# 3. Legacy /v1/automations path must not reappear in generated openapi.
if grep -n '"/v1/automations' packages/cli-core/src/engine-api/openapi.json >/dev/null 2>&1; then
  echo "ERROR: /v1/automations path present in cli-core openapi.json" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "terminology gate failed" >&2
  exit 1
fi

echo "terminology gate: OK"
