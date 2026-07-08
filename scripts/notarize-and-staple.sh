#!/usr/bin/env bash
set -euo pipefail

artifact="${1:-}"
if [ -z "$artifact" ]; then
  echo "Usage: scripts/notarize-and-staple.sh <artifact.app|artifact.dmg>" >&2
  exit 2
fi

if [ ! -e "$artifact" ]; then
  echo "Artifact does not exist: $artifact" >&2
  exit 2
fi

for name in APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for macOS notarization" >&2
    exit 2
  fi
done

label="$(basename "$artifact")"
safe_label="$(printf '%s' "$artifact" | tr -c 'A-Za-z0-9_.-' '_')"
tmp_root="${NOTARY_TEMP_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
submit_path="$artifact"

if [ -d "$artifact" ] && [[ "$artifact" == *.app ]]; then
  submit_path="$tmp_root/notary-${safe_label}.zip"
  echo "Zipping app bundle for notarization: $artifact"
  (cd "$(dirname "$artifact")" && ditto -c -k --sequesterRsrc --keepParent "$(basename "$artifact")" "$submit_path")
fi

echo "Submitting $artifact for notarization"
submit_json="$(xcrun notarytool submit "$submit_path" \
  --key "$APPLE_API_KEY" \
  --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER" \
  --output-format json)"
printf '%s\n' "$submit_json" > "$tmp_root/notary-submit-${safe_label}.json"
request_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<< "$submit_json")"
echo "Notary request id for $label: $request_id"

started="$(date +%s)"
timeout_seconds="${NOTARY_TIMEOUT_SECONDS:-7200}"
poll_seconds="${NOTARY_POLL_SECONDS:-30}"

while :; do
  info_json="$(xcrun notarytool info "$request_id" \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --output-format json)"
  printf '%s\n' "$info_json" > "$tmp_root/notary-info-${safe_label}.json"
  status="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' <<< "$info_json")"
  elapsed="$(( $(date +%s) - started ))"
  echo "Notary status for $label after ${elapsed}s: ${status:-unknown}"

  case "$status" in
    Accepted)
      break
      ;;
    Invalid|Rejected)
      xcrun notarytool log "$request_id" \
        --key "$APPLE_API_KEY" \
        --key-id "$APPLE_API_KEY_ID" \
        --issuer "$APPLE_API_ISSUER" || true
      exit 1
      ;;
  esac

  if [ "$elapsed" -ge "$timeout_seconds" ]; then
    echo "Timed out waiting for notarization of $artifact" >&2
    xcrun notarytool log "$request_id" \
      --key "$APPLE_API_KEY" \
      --key-id "$APPLE_API_KEY_ID" \
      --issuer "$APPLE_API_ISSUER" || true
    exit 124
  fi

  sleep "$poll_seconds"
done

echo "Stapling $artifact"
xcrun stapler staple "$artifact"
xcrun stapler validate "$artifact"
