#!/bin/bash
# Deploy built game to GitHub Pages — calls /internal/deploy on the server
set -euo pipefail

DAY="${1:?Usage: deploy.sh <day_number> \"<title>\"}"
TITLE="${2:-GameADay}"

WORKSPACE="$(cd "$(dirname "$0")/../../.." && pwd)"
OUTPUT="$WORKSPACE/output"

if [ ! -f "$OUTPUT/index.pck" ]; then
  echo "ERROR: No build output found. Run build-game first."
  exit 1
fi

# Base64 encode the .pck
PCK_BASE64=$(base64 -w0 "$OUTPUT/index.pck")

# Call the internal deploy endpoint
RESULT=$(curl -s -X POST "http://localhost:${PORT:-8080}/internal/deploy" \
  -H "Content-Type: application/json" \
  -d "{\"day\": $DAY, \"title\": $(echo "$TITLE" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))"), \"pck_base64\": \"$PCK_BASE64\", \"output_dir\": \"$OUTPUT\"}")

echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ghpages_url', d.get('error', 'unknown')))"
