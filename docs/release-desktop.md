# 桌面客户端发版操作清单（AIDCP Edge desktop release）

> 把「重打安装包 → 上传服务器 → 后台下载页跟上」整条流程固化下来，照着勾就行。
> 跨两个仓：构建在 **aidcp-edge**，下载配置与后台部署在 **aidcp-console**，托管在 **ECS**。
> 部署铁律与生产机细节以中控仓 `../aidcp/CLAUDE.md` §5/§6 为权威。

## 0. 先搞清楚的几个事实（为什么要这么做）

- **桌面包 = aidcp-edge 的 Electron 应用**。外壳启动后拉起编译产物 `dist/main.js` 跑整个边缘运行时，所以 **任何 edge 源码改动都要重打安装包才进包**，光改代码不重打没用。
- **下载地址是自有服务器，不是 GitHub**。安装包托管在 ECS `/opt/aidcp/downloads/`，Nginx 以 `/downloads/` 提供；后台「下载客户端」按钮的地址 **写死在前端** `aidcp-console/src/config/downloads.ts`。
- **mac 的 dmg 必须在 macOS 上构建并签名/公证**（依赖 `hdiutil`、Developer ID、`notarytool` 等 mac 专有工具），本机 Windows 打不了 → 走 **GitHub Actions** 的 macOS runner。
- **mac 发布包必须可信**：GitHub Actions 用 Developer ID Application 证书签名、Apple notarization 公证并 staple；未通过 `codesign` / `spctl` / `stapler` 的 mac 包不得上传或切下载配置。
- **无自动更新**：还没接 electron-updater → 用户升级要 **重新下载安装**。
- **红线**：生产机上 **只碰 `/opt/aidcp/downloads` 和 `/opt/aidcp/console`，绝不碰同机 isales**。
- **SSH**：`ssh -i ~/codes/isales-4.pem root@121.89.85.150`（私钥须存在；在 harness 里跑 ssh/scp 命令要 `dangerouslyDisableSandbox`，且可能被 auto-mode 分类器要二次确认，正常放行）。

下面以发布 `<版本>`（示例 `0.2.0`）为例。

---

## 1. 定版本号（aidcp-edge）

- [ ] 改 `aidcp-edge/package.json` 的 `version` → `<版本>`。
- [ ] 同步锁文件：`npm install --package-lock-only`
      —— 否则 CI 的 `npm ci` 会因 lockfile 根版本与 package.json 不一致而失败。
- [ ] 提交并推 `master`。

## 2. 构建安装包

### 2A. Windows（本机可打）

```bash
cd aidcp-edge
npm run electron:build:win
# 产物：dist-electron/AIDCP Setup <版本>.exe
```

### 2B. macOS（必须用 CI；本机 Windows 打不了）

工作流：`aidcp-edge/.github/workflows/build-desktop.yml`（手动触发）。
核心脚本：`aidcp-edge/scripts/build-desktop-macos.sh`，GitHub Actions 也是调用这个脚本完成签名、公证、staple 和 Gatekeeper 校验。

- [ ] 确保第 1 步已推到 `master`（CI 从 master 拉代码）。
- [ ] 确认仓库 Actions secrets 已配置且只通过 GitHub Secrets 注入，绝不写进仓库/日志/文档：
      `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD` / `APPLE_API_KEY_BASE64` /
      `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` / `APPLE_TEAM_ID`。
- [ ] 触发构建：
      - 网页：GitHub → 仓库 → **Actions** → 左侧 **Build Desktop Installers** → **Run workflow** → 选 `master` → 跑。
      - 或命令行：`gh workflow run build-desktop.yml --ref master`，再 `gh run watch <run-id>` 看进度。
- [ ] macOS job 必须完成以下闸后才会上传 artifact：
      - `.app`：`codesign --verify --deep --strict`、`spctl --assess --type exec`、`xcrun stapler validate`
      - `.dmg`：`xcrun stapler validate`、`spctl --assess --type open --context context:primary-signature`
- [ ] Apple notarization 是异步队列，不是每次都要 60 分钟以上；正常可能几分钟到几十分钟，但本项目首次配置时实测存在超过 60 分钟才 `Accepted` 的提交，所以脚本按“偶发很慢”处理：x64/arm64 并行提交，单个 submission 最长等待 2 小时，macOS job 总上限 6 小时。
- [ ] 跑完下载产物（macOS 那份）：
      ```bash
      gh run download <run-id> --name aidcp-macos --dir <某临时目录>
      ```
      得到：`AIDCP-<版本>-arm64.dmg`（Apple 芯片）、`AIDCP-<版本>.dmg`（Intel），外加 zip/blockmap（下载页用不到，忽略）。

> 这个工作流同时也产出 Windows exe（产物名 `aidcp-windows`）。想三平台全用 CI 出、不本地打也行——下载 `aidcp-windows` 即可。

## 3. 上传安装包到服务器

- [ ] 确认私钥在位：`ls -l ~/codes/isales-4.pem`。
- [ ] 上传（文件名按实际版本；exe 名里有空格，记得整体加引号）：
      ```bash
      scp -i ~/codes/isales-4.pem \
        "<...>/AIDCP Setup <版本>.exe" \
        "<...>/AIDCP-<版本>-arm64.dmg" \
        "<...>/AIDCP-<版本>.dmg" \
        root@121.89.85.150:/opt/aidcp/downloads/
      ```
- [ ] 旧版本文件可留可删（后台不再引用即无害）。

## 4. 改后台下载配置（aidcp-console）

改 `aidcp-console/src/config/downloads.ts`：

- [ ] `version` → `<版本>`。
- [ ] 三个 `file` 名 → 新文件名（**必须与第 3 步实际上传的文件名逐字一致**）。
- [ ] 提交并推 `master`。

## 5. 重新构建并部署 console（aidcp-console）

本机无 rsync，走 tar-over-ssh，**先备份再覆盖**。

```bash
cd aidcp-console
npm run build            # tsc --noEmit && vite build → dist/
tar czf /tmp/console-dist.tar.gz -C dist .
scp -i ~/codes/isales-4.pem /tmp/console-dist.tar.gz root@121.89.85.150:/tmp/
ssh -i ~/codes/isales-4.pem root@121.89.85.150 'set -e; \
  ts=$(date +%Y%m%d-%H%M%S); cd /opt/aidcp; \
  tar czf console.bak.$ts.tar.gz console; \
  rm -rf console/assets; \
  tar xzf /tmp/console-dist.tar.gz -C console; \
  rm -f /tmp/console-dist.tar.gz; \
  echo "deployed; bundle ->"; grep -o "assets/index-[A-Za-z0-9_-]*\.js" console/index.html'
```

- [ ] 回显里能看到 `index.html` 指向新的 bundle hash。

## 6. 验活（HTTP，在 ECS 本机 curl :8088）

```bash
ssh -i ~/codes/isales-4.pem root@121.89.85.150 '
  echo "-- 后台首页 --"; curl -sS -o /dev/null -w "http=%{http_code}\n" http://127.0.0.1:8088/;
  echo "-- win exe --"; curl -sSI "http://127.0.0.1:8088/downloads/AIDCP%20Setup%20<版本>.exe" | grep -iE "HTTP/|content-length";
  echo "-- mac arm64 --"; curl -sSI "http://127.0.0.1:8088/downloads/AIDCP-<版本>-arm64.dmg" | grep -iE "HTTP/|content-length";
  echo "-- mac x64 --"; curl -sSI "http://127.0.0.1:8088/downloads/AIDCP-<版本>.dmg" | grep -iE "HTTP/|content-length"'
```

- [ ] 三平台 URL 都 `200`，且 `Content-Length` 与本地文件字节数一致。
- [ ] exe 文件名有空格 → URL 里用 `%20`（按钮拼地址时 `encodeURIComponent` 已处理）。

## 7. 收尾 / 已知边界

- 真机访问后台走 **:8088 或 IP**（:80 域名 `aidcp.tommax.cc` 未备案前打不开）。
- 用户升级需 **重新下载安装**（无自动更新）。
- mac 用户仍可能看到一次“从互联网下载，是否打开”的普通确认；如果出现“无法验证开发者 / Apple 无法检查是否恶意软件”这类阻断提示，说明签名/公证闸失效，必须停止发布并回查 CI。

---

## 附：CI 工作流要点（build-desktop.yml）

- **手动触发**（`workflow_dispatch`）；`macos-latest` 出 x64+arm64 dmg/zip，`windows-latest` 出 nsis exe；产物作为 run artifact，保留 14 天。
- **必须 `electron-builder --publish never`**：CI 环境里 electron-builder 会自动尝试把产物发布到 GitHub release，缺 `GH_TOKEN` 直接报错（构建本身是成功的，只卡在发布步）。
- **mac 签名/公证**：`scripts/build-desktop-macos.sh` 先构建签名 `.app`，调用 `scripts/notarize-and-staple.sh` 并行公证/staple x64/arm64 `.app`，随后生成 dmg/zip 并并行公证/staple `.dmg`。`package.json` 的 mac 配置启用 `forceCodeSigning`、hardened runtime、entitlements，并关闭 electron-builder 内置 notarization。
- **签名失败必须失败**：证书、公证凭据、staple 或 Gatekeeper 校验任一失败，macOS job 必须非零退出，不能上传 unsigned/bad ticket 包。
- **CI 产物 ≠ 下载地址**：14 天过期、私有仓要 GitHub 登录、是临时签名 URL、还套了一层 zip → **不能**直接挂后台，只能下载下来再转存到 ECS `/downloads/`（即第 3 步）。后台始终用自有服务器的固定地址。
- `gh` 本机已登录（含 `repo` 权限），可直接 `gh workflow run` / `gh run watch` / `gh run download`。

## 相关文档

- 部署铁律 / 生产机 / isales 红线：`../aidcp/CLAUDE.md` §5/§6。
- 后台下载配置内联说明：`aidcp-console/src/config/downloads.ts` 顶部注释。
- Nginx 下载 location：`aidcp-console/deploy/aidcp-console.conf`（`location /downloads/`）。
