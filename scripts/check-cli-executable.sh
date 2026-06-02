#!/bin/bash
# CI guard: CLI entrypoints must be executable.
#
# Why: bun-link installs symlinks to the bin files directly. If a mode bit
# regresses to 100644, the very first `gbrain --version` or `rbrain --version`
# invocation fails with `permission denied`. v0.28.5 (cluster C, #683) fixed
# the original `gbrain` regression; this guard prevents drift for both bins.
#
# Wired into `bun run verify`. Fast, no external deps.
set -e

check_entrypoint() {
  local file="$1"
  local mode
  mode=$(git ls-files --stage "$file" | awk '{print $1}')

  if [ -n "$mode" ]; then
    if [ "$mode" != "100755" ]; then
      echo "FAIL: $file is tracked at mode $mode; expected 100755 (executable)."
      echo ""
      echo "Fix: chmod +x $file && git add --chmod=+x $file"
      echo ""
      echo "Background: bun-link installs symlink to this file directly. Mode 100644"
      echo "produces 'permission denied' on first invocation (issue #683)."
      exit 1
    fi
    echo "OK: $file is git-tracked as executable (100755)"
    return
  fi

  if [ -x "$file" ]; then
    echo "OK: $file is executable on disk; git will record 100755 when added"
    return
  fi

  echo "FAIL: $file is not tracked yet and is not executable on disk."
  echo ""
  echo "Fix: chmod +x $file"
  exit 1
}

check_entrypoint src/cli.ts
check_entrypoint src/rbrain.ts
