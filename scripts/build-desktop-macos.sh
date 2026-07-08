#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "macOS desktop artifacts must be built on macOS." >&2
  exit 2
fi

for name in CSC_LINK CSC_KEY_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required for signed macOS release builds" >&2
    exit 2
  fi
done

arch_list="${AIDCP_MAC_ARCHES:-x64 arm64}"
notary_script="$repo_root/scripts/notarize-and-staple.sh"
export NOTARY_TIMEOUT_SECONDS="${NOTARY_TIMEOUT_SECONDS:-7200}"
export NOTARY_POLL_SECONDS="${NOTARY_POLL_SECONDS:-30}"
export NOTARY_TEMP_DIR="${NOTARY_TEMP_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"

app_dir_for_arch() {
  case "$1" in
    x64) echo "dist-electron/mac" ;;
    arm64) echo "dist-electron/mac-arm64" ;;
    *)
      echo "Unsupported macOS arch: $1" >&2
      return 2
      ;;
  esac
}

notarize_parallel() {
  if [ "$#" -eq 0 ]; then
    echo "No artifacts provided for notarization" >&2
    return 1
  fi

  local pids=()
  local artifact
  local pid
  local failed=0

  for artifact in "$@"; do
    "$notary_script" "$artifact" &
    pid="$!"
    pids+=("$pid")
    echo "Started notarization for $artifact as pid $pid"
  done

  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      failed=1
    fi
  done

  return "$failed"
}

verify_trust_gates() {
  local artifacts=("$@")
  local artifact

  for artifact in "${artifacts[@]}"; do
    case "$artifact" in
      *.app)
        echo "Verifying app bundle $artifact"
        codesign --verify --deep --strict --verbose=2 "$artifact"
        spctl --assess --verbose --type exec "$artifact"
        xcrun stapler validate "$artifact"
        ;;
      *.dmg)
        echo "Verifying DMG $artifact"
        xcrun stapler validate "$artifact"
        spctl --assess --verbose --type open --context context:primary-signature "$artifact"
        ;;
      *)
        echo "Skipping trust gate for unsupported artifact: $artifact" >&2
        ;;
    esac
  done
}

builder_arch_args=()
app_artifacts=()
for arch in $arch_list; do
  builder_arch_args+=("--$arch")
done

echo "Building signed macOS app bundles for: $arch_list"
npm run build:dist
npx electron-builder --mac dir "${builder_arch_args[@]}" --publish never -c.mac.notarize=false

for arch in $arch_list; do
  app_dir="$(app_dir_for_arch "$arch")"
  app_path="$app_dir/AIDCP.app"
  if [ ! -d "$app_path" ]; then
    echo "Missing $arch app bundle: $app_path" >&2
    exit 1
  fi
  app_artifacts+=("$app_path")
done

echo "Notarizing and stapling app bundles"
notarize_parallel "${app_artifacts[@]}"

echo "Building macOS dmg/zip distributables"
for arch in $arch_list; do
  app_dir="$(app_dir_for_arch "$arch")"
  npx electron-builder --mac "--$arch" --prepackaged "$app_dir" --publish never -c.mac.notarize=false
done

shopt -s nullglob
dmg_artifacts=(dist-electron/*.dmg)
if [ "${#dmg_artifacts[@]}" -eq 0 ]; then
  echo "No DMG artifacts found" >&2
  exit 1
fi

echo "Notarizing and stapling DMGs"
notarize_parallel "${dmg_artifacts[@]}"

echo "Verifying macOS trust gates"
verify_trust_gates "${app_artifacts[@]}" "${dmg_artifacts[@]}"
