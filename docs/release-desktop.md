# 桌面客户端发版操作清单（AIDCP Edge desktop release）

> 把「重打安装包 → 上传服务器 → 后台下载页跟上」整条流程固化下来，照着勾就行。
> 跨两个仓：构建在 **aidcp-edge**，下载配置与后台部署在 **aidcp-console**，托管在 **ECS**。
> 部署铁律与生产机细节以中控仓 `../aidcp/CLAUDE.md` §5/§6 为权威。

## 0. 先搞清楚的几个事实（为什么要这么做）

- **桌面包 = aidcp-edge 的 Electron 应用**。外壳启动后拉起编译产物 `dist/main.js` 跑整个边缘运行时，所以 **任何 edge 源码改动都要重打安装包才进包**，光改代码不重打没用。
- **下载地址是自有服务器，不是 GitHub**。安装包托管在 ECS `/opt/aidcp/downloads/`，Nginx 以 `/downloads/` 提供；后台「下载客户端」按钮的地址 **写死在前端** `aidcp-console/src/config/downloads.ts`。
- **mac 的 dmg 必须在 macOS 上构建**（依赖 `hdiutil` 等 mac 专有工具），本机 Windows 打不了 → 走 **GitHub Actions** 的 macOS runner。
- **不签名、无自动更新**：app 是 unsigned（`build.mac.identity = null`），也没接 electron-updater → 用户升级要 **重新下载安装**。
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

- [ ] 确保第 1 步已推到 `master`（CI 从 master 拉代码）。
- [ ] 触发构建：
      - 网页：GitHub → 仓库 → **Actions** → 左侧 **Build Desktop Installers** → **Run workflow** → 选 `master` → 跑。
      - 或命令行：`gh workflow run build-desktop.yml --ref master`，再 `gh run watch <run-id>` 看进度。
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
- 不签名 → mac 用户首次打开要手动允许一下（与历史一致，非本次回退）。

---

## 附：CI 工作流要点（build-desktop.yml）

- **手动触发**（`workflow_dispatch`）；`macos-latest` 出 x64+arm64 dmg/zip，`windows-latest` 出 nsis exe；产物作为 run artifact，保留 14 天。
- **必须 `electron-builder --publish never`**：CI 环境里 electron-builder 会自动尝试把产物发布到 GitHub release，缺 `GH_TOKEN` 直接报错（构建本身是成功的，只卡在发布步）。
- **不签名**：`mac.identity = null` + `CSC_IDENTITY_AUTO_DISCOVERY=false`，无需任何 Apple 证书 / secret。
- **CI 产物 ≠ 下载地址**：14 天过期、私有仓要 GitHub 登录、是临时签名 URL、还套了一层 zip → **不能**直接挂后台，只能下载下来再转存到 ECS `/downloads/`（即第 3 步）。后台始终用自有服务器的固定地址。
- `gh` 本机已登录（含 `repo` 权限），可直接 `gh workflow run` / `gh run watch` / `gh run download`。

## 相关文档

- 部署铁律 / 生产机 / isales 红线：`../aidcp/CLAUDE.md` §5/§6。
- 后台下载配置内联说明：`aidcp-console/src/config/downloads.ts` 顶部注释。
- Nginx 下载 location：`aidcp-console/deploy/aidcp-console.conf`（`location /downloads/`）。
