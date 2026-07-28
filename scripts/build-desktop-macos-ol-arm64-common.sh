#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  signed-only|notarized) ;;
  *)
    echo "usage: $(basename "$0") <signed-only|notarized>" >&2
    exit 2
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEAM_ID="DK3BYZ9K32"
AUTH_URL="${AIDCP_CLIENT_AUTH_URL:-http://123.56.253.183:8088/capi}"
MOUNT_DIR=""
MOUNTED=0

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_file() {
  [ -f "$1" ] || die "missing file: $1"
}

cleanup() {
  if [ "$MOUNTED" = "1" ] && [ -n "$MOUNT_DIR" ]; then
    hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
  fi
  if [ -n "$MOUNT_DIR" ]; then
    rmdir "$MOUNT_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

resolve_control_root() {
  if [ -n "${AIDCP_CONTROL_ROOT:-}" ]; then
    printf '%s\n' "$AIDCP_CONTROL_ROOT"
    return
  fi

  local common_dir
  local edge_canonical
  common_dir="$(git -C "$REPO_ROOT" rev-parse --git-common-dir)"
  case "$common_dir" in
    /*) ;;
    *) common_dir="$REPO_ROOT/$common_dir" ;;
  esac
  edge_canonical="$(cd "$common_dir/.." && pwd -P)"
  printf '%s/aidcp\n' "$(dirname "$edge_canonical")"
}

prepare_rust_toolchain() {
  local rust_version
  local rustup_bin
  rust_version="$(
    sed -nE \
      's/^rust-version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' \
      "$REPO_ROOT/native/page-engine/Cargo.toml" |
      head -n 1
  )"
  [ -n "$rust_version" ] || die "native/page-engine/Cargo.toml has no rust-version"

  rustup_bin="${AIDCP_RUSTUP_BIN:-}"
  if [ -z "$rustup_bin" ]; then
    rustup_bin="$(command -v rustup || true)"
  fi
  if [ -z "$rustup_bin" ] && [ -x /opt/homebrew/bin/rustup ]; then
    rustup_bin="/opt/homebrew/bin/rustup"
  fi
  [ -x "$rustup_bin" ] || die "rustup is required; set AIDCP_RUSTUP_BIN"

  if ! RUSTUP_TOOLCHAIN="$rust_version" "$rustup_bin" which cargo >/dev/null 2>&1; then
    echo "Installing Rust $rust_version"
    "$rustup_bin" toolchain install "$rust_version" --profile minimal
  fi
  "$rustup_bin" target add --toolchain "$rust_version" aarch64-apple-darwin

  export RUSTUP_TOOLCHAIN="$rust_version"
  export AIDCP_CARGO_BIN="$("$rustup_bin" which cargo)"
  export RUSTC="$("$rustup_bin" which rustc)"
  "$AIDCP_CARGO_BIN" --version
  "$RUSTC" --version
}

prepare_signing_credentials() {
  local identity
  if [ -n "${CSC_NAME:-}" ]; then
    security find-identity -v -p codesigning |
      grep -F "\"$CSC_NAME\"" >/dev/null ||
      die "CSC_NAME is not available in the macOS keychain"
    return
  fi

  if [ -n "${CSC_LINK:-}" ]; then
    case "$CSC_LINK" in
      file://*) require_file "${CSC_LINK#file://}" ;;
      http://*|https://*) ;;
      *) require_file "$CSC_LINK" ;;
    esac
    if [ -z "${CSC_KEY_PASSWORD:-}" ]; then
      [ -r /dev/tty ] || die "CSC_KEY_PASSWORD is required without an interactive terminal"
      printf 'Developer ID p12 password: ' >/dev/tty
      IFS= read -r -s CSC_KEY_PASSWORD </dev/tty
      printf '\n' >/dev/tty
      export CSC_KEY_PASSWORD
    fi
    return
  fi

  identity="$(
    security find-identity -v -p codesigning |
      grep -F "Developer ID Application:" |
      grep -F "($TEAM_ID)" |
      sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' |
      head -n 1
  )"
  [ -n "$identity" ] ||
    die "no Developer ID Application identity for Team ID $TEAM_ID; set CSC_NAME or CSC_LINK"
  export CSC_NAME="$identity"
  echo "Using installed signing identity: $CSC_NAME"
}

prepare_notary_credentials() {
  [ "$MODE" = "notarized" ] || return 0

  local name
  for name in APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
    [ -n "${!name:-}" ] || die "$name is required for notarized builds"
  done
  require_file "$APPLE_API_KEY"
  export APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
  export NOTARY_TIMEOUT_SECONDS="${NOTARY_TIMEOUT_SECONDS:-7200}"
  export NOTARY_POLL_SECONDS="${NOTARY_POLL_SECONDS:-30}"
  if [ -z "${NOTARY_TEMP_DIR:-}" ]; then
    NOTARY_TEMP_DIR="$(mktemp -d /tmp/aidcp-notary-arm64.XXXXXX)"
    export NOTARY_TEMP_DIR
  fi
  echo "Notary temporary files: $NOTARY_TEMP_DIR"
}

verify_checkout_inputs() {
  local tracked_changes
  local untracked_build_inputs
  local unrelated_untracked

  tracked_changes="$(git status --porcelain --untracked-files=no)"
  if [ -n "$tracked_changes" ]; then
    printf '%s\n' "$tracked_changes" >&2
    die "aidcp-edge tracked files must be clean before packaging"
  fi

  untracked_build_inputs="$(
    git ls-files --others --exclude-standard -- src native scripts
  )"
  if [ -n "$untracked_build_inputs" ]; then
    printf '%s\n' "$untracked_build_inputs" >&2
    die "untracked build-related source files must be committed or moved before packaging"
  fi

  unrelated_untracked="$(
    git status --short --untracked-files=normal |
      sed -n 's/^?? //p'
  )"
  if [ -n "$unrelated_untracked" ]; then
    echo "Preserving unrelated untracked paths outside packaged source inputs:"
    printf '  %s\n' "$unrelated_untracked"
  fi
}

run_source_and_packaging_checks() {
  npm ci --prefer-offline
  npm run verify:desktop-build-input
  npm run typecheck
  npx tsx --test \
    test/electron/lifecycle-contract.test.ts \
    test/electron/gost-packaging-contract.test.ts \
    test/electron/proxy-chain-gost.integration.test.ts \
    test/electron/native-page-engine-artifact.test.ts \
    test/electron/ads-runtime.test.ts \
    test/electron/ads-runtime-stage.test.ts \
    test/electron/local-macos-release-scripts.test.ts

  npm run build:dist
  npm run build:ads-runtime
  npm run build:gost -- arm64
  npm run build:native-page-engines-for-package -- arm64
}

verify_app_signature() {
  local app="$1"
  local resources="$app/Contents/Resources"
  node "$REPO_ROOT/scripts/verify-signed-macos-artifacts.cjs" "$app" arm64
  codesign --verify --strict --verbose=2 "$resources/gost/gost"
  codesign --verify --strict --verbose=2 \
    "$resources/native-page-engine/aidcp-page-engine"
  codesign --verify --strict --verbose=2 \
    "$resources/adspower-browser/sqlite/arm64/node_sqlite3.node"
  codesign --verify --deep --strict --verbose=2 "$app"
}

verify_final_dmg() {
  local dmg="$1"
  local app
  local resources
  local asar_path
  local gost
  local native
  local ads
  local ads_sqlite
  local artifact

  MOUNT_DIR="$(mktemp -d /tmp/aidcp-release-dmg.XXXXXX)"
  hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$MOUNT_DIR" >/dev/null
  MOUNTED=1

  app="$MOUNT_DIR/AIDCP.app"
  resources="$app/Contents/Resources"
  asar_path="$resources/app.asar"
  gost="$resources/gost/gost"
  native="$resources/native-page-engine/aidcp-page-engine"
  ads="$resources/adspower-browser"
  ads_sqlite="$ads/sqlite/arm64/node_sqlite3.node"

  [ -d "$app" ] || die "AIDCP.app is missing from $dmg"
  require_file "$asar_path"
  [ -x "$gost" ] || die "packaged GOST is missing or not executable"
  [ -x "$native" ] || die "packaged Native Page Engine is missing or not executable"
  require_file "$ads/cli/index.js"
  require_file "$ads/aidcp-runtime-template.json"
  require_file "$ads_sqlite"

  PACKAGED_ASAR="$asar_path" EXPECTED_AUTH_URL="$AUTH_URL" node <<'NODE'
const asar = require('@electron/asar');
const pkg = JSON.parse(
  asar.extractFile(process.env.PACKAGED_ASAR, 'package.json').toString('utf8'),
);
if (pkg.aidcpCloudDefaultEnv !== 'ol') {
  throw new Error(`Wrong packaged cloud environment: ${pkg.aidcpCloudDefaultEnv}`);
}
if (pkg.aidcpClientAuthUrl !== process.env.EXPECTED_AUTH_URL) {
  throw new Error(`Wrong packaged client auth URL: ${pkg.aidcpClientAuthUrl}`);
}
console.log('OK: OL environment and client auth URL verified');
NODE

  verify_app_signature "$app"
  for artifact in "$gost" "$native" "$ads_sqlite"; do
    file "$artifact" | grep -q 'arm64' ||
      die "packaged artifact is not arm64: $artifact"
    file "$artifact"
  done
  "$gost" -V

  if [ "$MODE" = "notarized" ]; then
    xcrun stapler validate "$app"
    spctl --assess --type exec --verbose=4 "$app"
    xcrun stapler validate "$dmg"
  fi

  hdiutil detach "$MOUNT_DIR" >/dev/null
  MOUNTED=0
  rmdir "$MOUNT_DIR"
  MOUNT_DIR=""
}

main() {
  cd "$REPO_ROOT"
  [ "$(uname -s)" = "Darwin" ] || die "macOS packages must be built on macOS"

  local control_root
  local version
  local source_commit
  local output_backup
  local builder_cli
  local app_dir
  local app
  local dmg
  local -a common_args

  control_root="$(resolve_control_root)"
  [ -x "$control_root/scripts/task-preflight" ] ||
    die "control repo task-preflight is unavailable; set AIDCP_CONTROL_ROOT"
  "$control_root/scripts/task-preflight"

  verify_checkout_inputs

  require_file "$REPO_ROOT/resources/ads-runtime.json"
  version="$(node -p "require('./package.json').version")"
  source_commit="$(git rev-parse --short HEAD)"
  echo "Source commit: $source_commit"
  echo "Package version: $version"
  echo "Release mode: $MODE"
  echo "Client auth URL: $AUTH_URL"

  prepare_rust_toolchain
  prepare_signing_credentials
  prepare_notary_credentials

  if [ -e "$REPO_ROOT/dist-electron" ]; then
    output_backup="$REPO_ROOT/dist-electron.backup-$(date +%Y%m%d-%H%M%S)-$$"
    mv "$REPO_ROOT/dist-electron" "$output_backup"
    echo "Previous artifacts moved to: $output_backup"
  fi

  run_source_and_packaging_checks

  export AIDCP_CLOUD_DEFAULT_ENV="ol"
  export AIDCP_CLIENT_AUTH_URL="$AUTH_URL"
  export CSC_IDENTITY_AUTO_DISCOVERY="true"
  builder_cli="$REPO_ROOT/node_modules/electron-builder/cli.js"
  require_file "$builder_cli"
  common_args=(
    --publish never
    -c.mac.notarize=false
    -c.mac.forceCodeSigning=true
    -c.extraMetadata.aidcpCloudDefaultEnv=ol
    "-c.extraMetadata.aidcpClientAuthUrl=$AUTH_URL"
  )

  app_dir="$REPO_ROOT/dist-electron/mac-arm64"
  app="$app_dir/AIDCP.app"
  dmg="$REPO_ROOT/dist-electron/AIDCP-${version}-arm64.dmg"

  if [ "$MODE" = "signed-only" ]; then
    node "$builder_cli" --mac dmg --arm64 "${common_args[@]}"
  else
    node "$builder_cli" --mac dir --arm64 "${common_args[@]}"
    [ -d "$app" ] || die "signed app was not generated: $app"
    verify_app_signature "$app"

    "$REPO_ROOT/scripts/notarize-and-staple.sh" "$app"
    verify_app_signature "$app"
    xcrun stapler validate "$app"
    spctl --assess --type exec --verbose=4 "$app"

    node "$builder_cli" \
      --mac \
      --arm64 \
      --prepackaged "$app_dir" \
      --publish never \
      -c.mac.target=dmg \
      -c.mac.notarize=false \
      -c.mac.forceCodeSigning=true
    require_file "$dmg"
    "$REPO_ROOT/scripts/notarize-and-staple.sh" "$dmg"
  fi

  require_file "$dmg"
  verify_final_dmg "$dmg"

  echo
  if [ "$MODE" = "notarized" ]; then
    echo "===== Build complete: Developer ID signed + notarized + stapled ====="
  else
    echo "===== Build complete: Developer ID signed only (NOT notarized) ====="
  fi
  echo "Version: $version"
  echo "Commit:  $source_commit"
  echo "DMG:     $dmg"
  shasum -a 256 "$dmg"
}

main
