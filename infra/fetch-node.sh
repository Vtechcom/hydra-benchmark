#!/usr/bin/env bash
# Put a hydra-node binary for one version in ./bin as `hydra-node-<version>`,
# so several versions sit side by side and an A/B run is a flag, not a rebuild.
#
#   ./infra/fetch-node.sh 2.3.0
#   ./infra/fetch-node.sh 2.2.0 --from /path/to/hydra-node   # locally built
#
# Fast path: a sibling checkout that already downloaded this exact version is
# symlinked instead of re-downloading ~185MB.
#
# Not every tag ships binaries — 2.2.0 has a GitHub release with ZERO assets and
# an amd64-only image, so on Apple Silicon it must be built from source (see
# docs/version-ab.md) and installed here with --from.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${1:-}"
[[ -n "$VERSION" ]] || { echo "usage: fetch-node.sh <version> [--from <binary>]   e.g. 2.3.0" >&2; exit 2; }
shift
FROM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
OUT="$DIR/bin/hydra-node-$VERSION"
mkdir -p "$DIR/bin"

# 0. an explicitly supplied binary (nix build result, scp'd artifact, …)
if [[ -n "$FROM" ]]; then
  [[ -x "$FROM" ]] || { echo "not an executable: $FROM" >&2; exit 1; }
  REPORTED="$("$FROM" --version 2>/dev/null || true)"
  case "$REPORTED" in
    "$VERSION"*) ;;
    *) echo "refusing: $FROM reports '$REPORTED', not $VERSION — a mislabelled binary poisons the whole result tree" >&2; exit 1 ;;
  esac
  ln -sf "$(cd "$(dirname "$FROM")" && pwd)/$(basename "$FROM")" "$OUT"
  echo "installed $REPORTED from $FROM"
  exit 0
fi

if [[ -x "$OUT" ]]; then
  echo "already present: $("$OUT" --version)"
  exit 0
fi

# 1. reuse a sibling checkout's binary — but only if it really is this version
for candidate in \
  "$DIR/../../hydra-graveyard/infra/preprod-offline/bin/hydra-node" \
  "$DIR/../../hydra-perps/infra/preprod-offline/bin/hydra-node"; do
  if [[ -x "$candidate" ]] && "$candidate" --version 2>/dev/null | grep -q "^$VERSION"; then
    ln -sf "$(cd "$(dirname "$candidate")" && pwd)/hydra-node" "$OUT"
    echo "linked $("$OUT" --version) from $(dirname "$candidate")"
    exit 0
  fi
done

# 2. GitHub release
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)  ASSET="hydra-aarch64-darwin-$VERSION.zip" ;;
  Darwin/x86_64) ASSET="hydra-x86_64-darwin-$VERSION.zip" ;;
  Linux/x86_64)  ASSET="hydra-x86_64-linux-$VERSION.zip" ;;
  Linux/aarch64) ASSET="hydra-aarch64-linux-$VERSION.zip" ;;
  *) echo "unsupported platform $(uname -s)/$(uname -m) — place the binary at $OUT yourself" >&2; exit 1 ;;
esac

command -v gh >/dev/null || { echo "gh CLI not found — install it, or place the binary at $OUT" >&2; exit 1; }

if ! gh release view "$VERSION" --repo cardano-scaling/hydra --json assets --jq '.assets[].name' 2>/dev/null | grep -q "$ASSET"; then
  echo "release $VERSION publishes no '$ASSET'." >&2
  echo "build it from source and install with --from (see docs/version-ab.md):" >&2
  echo "  git -C <hydra-checkout> worktree add /tmp/hydra-$VERSION $VERSION" >&2
  echo "  cd /tmp/hydra-$VERSION && nix build .#hydra-node" >&2
  echo "  ./infra/fetch-node.sh $VERSION --from /tmp/hydra-$VERSION/result/bin/hydra-node" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "downloading ${ASSET}…"
gh release download "$VERSION" --repo cardano-scaling/hydra --pattern "$ASSET" --dir "$TMP"
unzip -oq "$TMP/$ASSET" -d "$TMP"
mv "$TMP/hydra-node" "$OUT"
chmod +x "$OUT"
xattr -dr com.apple.quarantine "$OUT" 2>/dev/null || true   # macOS Gatekeeper
echo "ready: $("$OUT" --version)"
