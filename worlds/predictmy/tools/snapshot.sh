#!/usr/bin/env bash
#
# Take a snapshot of the deployed predictmy.ai build, for tools/extract.mjs.
#
# The port's input is the SHIPPED build, not a source tree — that is what makes
# it a port rather than a reimplementation. Every chunk name carries a Vite
# content hash, so a redeploy invalidates all of them at once; this script
# rediscovers them from index.html instead of hard-coding a list that would rot.
#
# The stadium backdrops ship as 3.3MB and 3.0MB PNGs, against a 2MB ceiling on a
# world's whole `assets/` directory (they are inlined into `index.json`, which
# the backend holds in memory). Re-encoding to WebP at the same 1536x1024 takes
# the pair to ~650KB with no visible loss, which is why `cwebp` is required.
#
#   ./tools/snapshot.sh [dest]      # default: /tmp/predictmy
#   node tools/extract.mjs [dest]
#
set -euo pipefail

SITE="https://predictmy.ai"
DEST="${1:-/tmp/predictmy}"
UA="Mozilla/5.0"

command -v cwebp >/dev/null || { echo "cwebp not found — brew install webp"; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST/assets" "$DEST/img"

echo "index.html"
curl -fsSL -A "$UA" "$SITE/" -o "$DEST/index.html"

# Every chunk the entry names, plus the lazily-imported data modules it reaches
# for at runtime. The second grep catches `import("./players-2026-HASH.js")`,
# which never appears in the HTML.
echo "chunks"
CHUNKS=$(grep -oE '/assets/[A-Za-z0-9_.-]+\.js' "$DEST/index.html" | sort -u | sed 's|/assets/||')
for f in $CHUNKS; do
  curl -fsSL -A "$UA" "$SITE/assets/$f" -o "$DEST/assets/$f"
done

# One pass is not enough: chunks name other chunks.
for _ in 1 2 3; do
  MORE=$(grep -ohE '\./[A-Za-z0-9_.-]+\.js' "$DEST"/assets/*.js | sed 's|\./||' | sort -u)
  for f in $MORE; do
    [ -f "$DEST/assets/$f" ] && continue
    echo "  + $f"
    curl -fsSL -A "$UA" "$SITE/assets/$f" -o "$DEST/assets/$f"
  done
done

echo "images"
for f in logo.png stadium-daytime.png stadium-night.png; do
  curl -fsSL -A "$UA" "$SITE/$f" -o "$DEST/img/$f"
done
cwebp -q 90 -quiet "$DEST/img/logo.png" -o "$DEST/img/logo.webp"
cwebp -q 78 -quiet "$DEST/img/stadium-daytime.png" -o "$DEST/img/stadium-daytime.webp"
cwebp -q 78 -quiet "$DEST/img/stadium-night.png" -o "$DEST/img/stadium-night.webp"

echo
echo "snapshot at $DEST"
echo "  chunks $(ls -1 "$DEST/assets" | wc -l | tr -d ' ')  ($(cat "$DEST"/assets/*.js | wc -c | tr -d ' ') bytes)"
echo "  images $(cat "$DEST"/img/*.webp | wc -c | tr -d ' ') bytes as webp"
echo
echo "next: node tools/extract.mjs $DEST"
