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
        native_engine="$artifact/Contents/Resources/native-page-engine/aidcp-page-engine"
        if [ ! -x "$native_engine" ]; then
          echo "Missing executable Native Page Engine in $artifact" >&2
          return 1
        fi
        codesign --verify --strict --verbose=2 "$native_engine"
        codesign --verify --deep --strict --verbose=2 "$artifact"
        spctl --assess --verbose --type exec "$artifact"
        xcrun stapler validate "$artifact"
        ;;
      *.dmg)
        # electron-builder ships an UNSIGNED dmg CONTAINER: the signed + notarized + stapled
        # .app inside is what Gatekeeper actually runs; the downloaded dmg opens without a
        # Gatekeeper prompt because the notarization ticket is stapled to it. `stapler validate`
        # is the authoritative notarization check for the dmg. We deliberately do NOT run
        # `spctl --assess --type open --context context:primary-signature` on the dmg — that
        # asserts a PRIMARY CODE SIGNATURE the container intentionally lacks and false-fails
        # ("rejected: no usable signature") even though the dmg is fully notarized. The .app's
        # full codesign + spctl (source=Notarized Developer ID) + stapler gates above already
        # prove the payload is Gatekeeper-clean.
        echo "Verifying DMG $artifact (stapled notarization ticket)"
        xcrun stapler validate "$artifact"
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
# 自包含指纹浏览器运行时（随包 AdsPower CLI），与本机 electron:build:mac 一致：先编译，再 stage 运行时。
npm run build:ads-runtime
# 客户包按目标架构携带 Native Page Engine；任一架构缺失或校验失败都禁止继续打包。
npm run build:native-page-engines-for-package -- $arch_list

# baked key（resources/ads-runtime.json）是 gitignored、不随仓库进 CI，但 extraResources 引用它——
# 缺失会让打包失败或出无 key 包。CI 必须在此之前从 ADS_RUNTIME_JSON_BASE64 secret 还原它
# （工作流的 "Materialize self-contained runtime key" 步骤）；本机打包由 checkout 时手放。
# 缺失即诚实失败，绝不静默出缺 key 的包。
if [ ! -f resources/ads-runtime.json ]; then
  echo "resources/ads-runtime.json is missing; self-contained runtime cannot be bundled." >&2
  echo "In CI, materialize it from the ADS_RUNTIME_JSON_BASE64 secret before this step." >&2
  exit 1
fi

# 分发包可在构建期烘焙缺省云端环境（AIDCP_CLOUD_DEFAULT_ENV=dev|ol）和客户登录门地址
# （AIDCP_CLIENT_AUTH_URL=http(s)://.../capi），注入 packaged package.json。客户端启动时据此决定
# "无界面选择/无启动环境变量"时连哪个云、是否一装即启用客户登录验证。
# 未设置则不注入 → 客户端回落其自身缺省 dev + 登录门关闭（零回归）。注入到 dir 构建（写 .app 内
# package.json）即可，后续 --prepackaged 复用已建 .app、无需重复。
builder_dir_args=("${builder_arch_args[@]}")
if [ -n "${AIDCP_CLOUD_DEFAULT_ENV:-}" ]; then
  case "$AIDCP_CLOUD_DEFAULT_ENV" in
    dev|ol)
      builder_dir_args+=("-c.extraMetadata.aidcpCloudDefaultEnv=$AIDCP_CLOUD_DEFAULT_ENV")
      echo "Baking default cloud env into build: $AIDCP_CLOUD_DEFAULT_ENV"
      ;;
    *)
      echo "Unsupported AIDCP_CLOUD_DEFAULT_ENV: $AIDCP_CLOUD_DEFAULT_ENV (want dev|ol)" >&2
      exit 2
      ;;
  esac
fi
client_auth_url="${AIDCP_CLIENT_AUTH_URL:-}"
if [ -z "$client_auth_url" ]; then
  case "${AIDCP_CLOUD_DEFAULT_ENV:-}" in
    dev) client_auth_url="http://121.89.85.150:8088/capi" ;;
    ol) client_auth_url="https://aidcp.tommax.cc/capi" ;;
  esac
fi
while [ -n "$client_auth_url" ] && [ "${client_auth_url%/}" != "$client_auth_url" ]; do
  client_auth_url="${client_auth_url%/}"
done
if [ -n "$client_auth_url" ]; then
  case "$client_auth_url" in
    http://*|https://*)
      builder_dir_args+=("-c.extraMetadata.aidcpClientAuthUrl=$client_auth_url")
      echo "Baking client auth URL into build: $client_auth_url"
      ;;
    *)
      echo "Unsupported AIDCP_CLIENT_AUTH_URL: $client_auth_url (want http(s)://...)" >&2
      exit 2
      ;;
  esac
fi

# forceCodeSigning 只在 CI（此脚本）施加、不写进 package.json：CSC_LINK 在位时 electron-builder 会签名，
# forceCodeSigning=true 让「签不成」直接失败（fail-closed，绝不静默出 unsigned 包）；而本机无证书跑
# electron:build:mac 时 package.json 不带此项 → 默认跳过签名、照出 unsigned 自测包（本机打包能力零回归）。
npx electron-builder --mac dir "${builder_dir_args[@]}" --publish never -c.mac.notarize=false -c.mac.forceCodeSigning=true

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
  npx electron-builder --mac "--$arch" --prepackaged "$app_dir" --publish never -c.mac.notarize=false -c.mac.forceCodeSigning=true
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
