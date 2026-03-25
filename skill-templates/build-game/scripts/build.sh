#!/bin/bash
# Build the Godot project — run from workspace root
set -euo pipefail

WORKSPACE="$(cd "$(dirname "$0")/../../.." && pwd)"
TEMPLATE="$WORKSPACE/template"
OUTPUT="$WORKSPACE/output"

# Copy main.gd into template
if [ -f "$WORKSPACE/main.gd" ]; then
  cp "$WORKSPACE/main.gd" "$TEMPLATE/main.gd"
fi

mkdir -p "$OUTPUT"

echo "=== Importing resources ==="
godot --headless --path "$TEMPLATE" --import 2>&1 || true

echo "=== Exporting for Web ==="
godot --headless --path "$TEMPLATE" --export-release "Web" "$OUTPUT/index.html" 2>&1

if [ -f "$OUTPUT/index.pck" ]; then
  SIZE=$(stat -c%s "$OUTPUT/index.pck" 2>/dev/null || stat -f%z "$OUTPUT/index.pck" 2>/dev/null)
  echo ""
  echo "BUILD SUCCESS: output/index.pck ($SIZE bytes)"
else
  echo ""
  echo "BUILD FAILED: no index.pck produced"
  exit 1
fi
