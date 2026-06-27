#!/usr/bin/env bash
#
# dev-run.sh — 本地起 edge + 实时合并 ECS 云端日志到同一终端，便于观测整条任务链路。
#
# 设计：
#   - edge 在前台运行（保留 TTY / stdin / 颜色，登录态“按 Enter 兜底”仍可用）；
#     其日志自带 [aidcp-edge] / [browse] / [edge-client] 前缀，与 [CLOUD] 天然区分。
#   - 云端 systemd journal 后台 tail（仅跟随新日志），逐行加 [CLOUD] 前缀。
#     awk fflush 保证实时、兼容 macOS（BSD sed 无 -u）。
#   - Ctrl+C 经 trap 把云端 tail 一并收掉。
#
# 用法：
#   npm run dev:cloud
#   AIDCP_AUTO_BROWSE=false npm run dev:cloud        # 只验边-云链路，不动平台
#   AIDCP_CLOUD_SVC=... AIDCP_ECS=... npm run dev:cloud   # 覆盖默认 ECS/服务名
#
# 注意：只读云端日志（journalctl -f），不触发任何云端写操作；只碰 aidcp-cloud，不碰 isales。
set -uo pipefail

PEM="${AIDCP_PEM:-$HOME/codes/isales-4.pem}"
ECS="${AIDCP_ECS:-root@121.89.85.150}"
SVC="${AIDCP_CLOUD_SVC:-aidcp-cloud.service}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cloud_pid=""
cleanup() { [[ -n "$cloud_pid" ]] && kill "$cloud_pid" 2>/dev/null; }
trap cleanup EXIT INT TERM

if [[ ! -f "$PEM" ]]; then
  echo "[dev-run] ⚠️ 未找到 SSH 私钥：${PEM}（设 AIDCP_PEM 覆盖）。仅本地起 edge，不合并云端日志。"
else
  echo "[dev-run] tail 云端 journal：${ECS} ${SVC}（Ctrl+C 一并退出）"
  ssh -i "$PEM" -o ConnectTimeout=10 "$ECS" "journalctl -u $SVC -f -n 0 --no-pager" 2>&1 \
    | awk '{ print "\033[36m[CLOUD]\033[0m " $0; fflush() }' &
  cloud_pid=$!
fi

# 身份默认从登录态读出（account-identity-from-login）：【不再强制 default】。
# 强制 default 会让边缘以覆盖值握手、丢掉真实登录账号身份——且 account-real-nickname 的诚实闸会因
# override(default) ≠ 真实登录 id 而【省略昵称】，后台账号列永远显示 default 而非真实账号/昵称。
# 前置：该节点 Chrome 已登录目标账号（读不出登录态边缘会诚实停手、不回落 default，红线）。
# 如需为特殊/预置场景显式指定身份，在外部 export AIDCP_ACCOUNT_ID 即可（此处不兜底）。

# edge 前台运行；透传外部环境变量（AIDCP_ACCOUNT_ID 覆盖 / AIDCP_AUTO_BROWSE / AIDCP_REAL_PUBLISH 等）。
cd "$REPO_DIR" && npm start
