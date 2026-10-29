#!/usr/bin/env bash
# db-query skill: one-shot environment check + install + test
# Install the locked dependencies in this skill directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

# ── Node / npm version check ──
if ! command -v node &>/dev/null; then
  echo "✗ node not found; Node.js >= 18 is required"
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js version $(node -v) is below the minimum required 18"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "✗ npm not found"
  exit 1
fi

echo "Node $(node -v) ✓  npm $(npm -v) ✓"

# ── Install and verify independently of the consuming project ──
echo "Installing locked runtime dependencies..."
npm ci --omit=dev --no-audit --no-fund
echo "Running tests..."
npm test

echo "db-query environment ready ✓"
