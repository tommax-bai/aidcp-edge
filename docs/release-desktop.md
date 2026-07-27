# 桌面客户端发版操作清单（AIDCP Edge desktop release）

> 把「重打安装包 → 上传服务器 → 后台下载页跟上」整条流程固化下来，照着勾就行。
> 跨两个仓：构建在 **aidcp-edge**，下载配置与后台部署在 **aidcp-console**，托管在 **ECS**。
> 部署铁律与生产机细节以中控仓 `../aidcp/CLAUDE.md` §5/§6 为权威。
>
> **交付半段（§3–4）已脚本化**：CI 出包后（下载 dmg → 静态校验 → 传包 → 验活），
> 可用中控仓 `scripts/release-desktop-macos <版本>`（默认只做本地只读段并打印剩余命令，加 `--yes` 才做对外动作）。
> **构建/签名/公证半段仍是 CI 专属**（§1–2），脚本不碰。判断点（版本号、CI 红了怎么办）也仍留人工。

## 0. 先搞清楚的几个事实（为什么要这么做）

- **桌面包 = aidcp-edge 的 Electron 应用**。外壳启动后拉起编译产物 `dist/main.js` 跑整个边缘运行时，所以 **任何 edge 源码改动都要重打安装包才进包**，光改代码不重打没用。
- **下载地址是自有服务器，不是 GitHub**。安装包托管在 ECS `/opt/aidcp/downloads/`，Nginx 以 `/downloads/` 提供。后台「下载客户端」按钮**不再写死版本号**（change `downloads-manifest-from-host`）：云端面板 `GET /api/downloads` **现扫该机的 downloads 目录**得出清单，页面只可能提供确实存在的包。**所以「发布」= 把包放到那台机器上——不改代码、不重新构建 console。**
- **mac 的 dmg 必须在 macOS 上构建**（依赖 `hdiutil` 等 mac 专有工具），本机 Windows 打不了 → 走 **GitHub Actions** 的 macOS runner。
- **正式分发默认走 CI 签名 + 公证**（Developer ID 签名 + Apple notarytool 公证 + staple）：这样用户下载安装**不会被 Gatekeeper 拦成「非法软件 / 无法验证开发者」**。仓库也提供本地 arm64 OL 的签名与公证入口；只有显式提供本机 Keychain/p12 和 App Store Connect API 凭据时才可生成对应信任级别的产物，凭据本身不进入仓库。所需 CI secret 见第 1 步。
- **无自动更新**：没接 electron-updater → 用户升级要 **重新下载安装**。
- **红线**：生产机上 **只碰 `/opt/aidcp/downloads` 和 `/opt/aidcp/console`，绝不碰同机 isales**。
- **SSH**：`ssh -i ~/codes/dev-0722.pem root@121.89.85.150`（私钥须存在；在 harness 里跑 ssh/scp 命令要 `dangerouslyDisableSandbox`，且可能被 auto-mode 分类器要二次确认，正常放行）。

下面以发布 `<版本>`（示例 `0.2.0`）为例。

---

## 1. 定版本号（aidcp-edge）

- [ ] 改 `aidcp-edge/package.json` 的 `version` → `<版本>`。
- [ ] 同步锁文件：`npm install --package-lock-only`
      —— 否则 CI 的 `npm ci` 会因 lockfile 根版本与 package.json 不一致而失败。
- [ ] 提交并推 `master`。
- [ ] **签名 / 公证 / 自包含运行时所需仓库 secret 必须齐全**（只经 GitHub Secrets 注入，绝不写进仓库 / 日志 / 文档）：
      `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`（Developer ID 证书 `.p12` + 密码）、
      `APPLE_API_KEY_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`、`APPLE_TEAM_ID`（App Store Connect API Key，公证用）、
      `ADS_RUNTIME_JSON_BASE64`（自包含指纹浏览器运行时的 baked key `resources/ads-runtime.json`——本机 gitignored、不进仓库，CI 从此 secret 还原；它本就 bake 进每个分发 `.app`，放 secret 更安全）。

## 2. 构建安装包

### 2A. Windows（本机可打）

```bash
cd aidcp-edge
npm run electron:build:win
# 产物：dist-electron/AIDCP Setup <版本>.exe
```

### 2B. macOS（正式分发默认走 CI；本机可显式签名或公证 arm64 OL 包）

- **CI 是正式分发默认入口**：凭据由 GitHub Secrets 注入，流程可复现并保留 Actions 证据。本机普通 `npm run electron:build:mac` 仍可能是 unsigned，只适合自测；不要把它当作下面两个显式本地发布入口。
- 工作流：`aidcp-edge/.github/workflows/build-desktop.yml`（手动触发；核心脚本 `scripts/build-desktop-macos.sh` 完成签名 → notarytool 公证 → staple → Gatekeeper 校验）。

- [ ] 确保第 1 步已推到 `master`（CI 从 master 拉代码），且第 1 步的 secret 齐全。
- [ ] 触发构建（**带烘焙缺省云端环境 + 客户登录门**）：
      - 网页：GitHub → 仓库 → **Actions** → **Build Desktop Installers** → **Run workflow** → 选 `master`、`cloud_default_env` 选 `dev` 或 `ol`（`ol` = 装完默认连线上）；`client_auth_url` 留空时，`ol` 构建默认烘焙 `https://aidcp.tommax.cc/capi` 并开启客户登录门；`include_windows` 默认关 → 跑。
      - 或命令行：`gh workflow run build-desktop.yml --ref master -f cloud_default_env=ol -f client_auth_url=https://aidcp.tommax.cc/capi`，再 `gh run watch <run-id>` 看进度。**公证是异步排队，正常几分钟到几十分钟，偶发 >1 小时**（脚本按此设上限）。
- [ ] 跑完下载产物（macOS 那份）：
      ```bash
      gh run download <run-id> --name aidcp-macos --dir <某临时目录>
      ```
      得到：`AIDCP-<版本>-arm64.dmg`（Apple 芯片）、`AIDCP-<版本>.dmg`（Intel），外加 zip/blockmap（下载页用不到，忽略）。

> **Windows 默认不出**（`include_windows` 关）：Windows job 尚未接自包含运行时的 staging，开了会因缺 `extraResources` 失败。等 Windows 自包含打包接好再开。

#### 本地 arm64 OL：仅 Developer ID 签名

脚本会自动从 Keychain 选择 Team ID `DK3BYZ9K32` 的 Developer ID Application 身份；也可通过
`CSC_NAME`，或 `CSC_LINK=/path/to/certificate.p12` 显式选择。使用 p12 且未设置
`CSC_KEY_PASSWORD` 时，脚本从终端隐式询问密码。

```bash
./scripts/build-desktop-macos-ol-arm64-signed.sh
```

该入口完整构建并验证 AdsPower CLI、GOST、Native Page Engine、OL 环境和客户登录 URL，
但**不调用 Apple 公证**。代码签名有效不等于 Gatekeeper 接受，输出会明确标记 `NOT notarized`。

#### 本地 arm64 OL：Developer ID 签名并公证

```bash
export APPLE_API_KEY=/absolute/path/to/AuthKey_KEYID.p8
export APPLE_API_KEY_ID=KEYID
export APPLE_API_ISSUER=issuer-uuid
./scripts/build-desktop-macos-ol-arm64-notarized.sh
```

该入口严格按“签名 App → 公证/staple App → 生成 DMG → 公证/staple DMG”执行，并验证最终
DMG 内应用的 Gatekeeper、staple、嵌套运行时签名和 arm64 架构。默认登录地址为
`http://123.56.253.183:8088/capi`；如 OL 地址调整，必须用
`AIDCP_CLIENT_AUTH_URL=http(s)://.../capi` 显式覆盖，脚本会在最终 `app.asar` 中回读确认。

两个入口都只生成本地文件，不上传、不部署、不发布。产物为
`dist-electron/AIDCP-<version>-arm64.dmg`；已有 `dist-electron` 会先移动到时间戳备份，
避免旧架构或旧版本 DMG 混入本次验证/公证。

### 2C. 打包后本机冒烟（发版前必做，别省）

> **为什么必做**：有一类只在打包态才犯的 bug——核心子进程 spawn 的工作目录落进 `app.asar`（一个文件、非目录），macOS 抛 `spawn ENOTDIR`，核心起不来、浏览器无法启动。**本地 `electron .`、`npm run typecheck`、单测全抓不到**，只有跑打包产物才暴露。已复发过两次（`0.3.5` 又发出去一次）。详见 `aidcp-edge/CLAUDE.md`「打包红线」。

- [ ] **源码级回归已兜底**：`npx tsx --test test/electron/lifecycle-contract.test.ts` 会断言核心 spawn 的 cwd 是 asar 守卫后的值、绝不是裸 `appRoot`。改过 `src/electron/**` 的先跑它。
- [ ] **产物级校验（快，不用真机 AdsPower）**：确认修复真进了包的 asar——
      ```bash
      node -e "const a=require('@electron/asar');const s=a.extractFile('dist-electron/mac-arm64/AIDCP.app/Contents/Resources/app.asar','src/electron/main.cjs').toString();console.log(/cwd:\s*edgeCwd/.test(s)&&!/cwd:\s*appRoot\b/.test(s)?'OK: cwd asar-guarded':'FAIL: raw appRoot cwd shipped')"
      ```
- [ ] **真机冒烟（发正式版前至少一次）**：装上刚打的 dmg，点「启动」，确认核心不 `ENOTDIR`、能走到「正在启动指纹浏览器」并真的弹出浏览器（需 AdsPower 在跑 + 至少一个环境）。日志：`~/Library/Application Support/aidcp-edge/logs/app.log` 里 spawn 行的 `cwd=` 应是 `.../Contents/Resources`、不是 `.../app.asar`。

## 3. 上传安装包到服务器

- [ ] 确认私钥在位：`ls -l ~/codes/dev-0722.pem`。
- [ ] 上传（文件名按实际版本；exe 名里有空格，记得整体加引号）：
      ```bash
      scp -i ~/codes/dev-0722.pem \
        "<...>/AIDCP Setup <版本>.exe" \
        "<...>/AIDCP-<版本>-arm64.dmg" \
        "<...>/AIDCP-<版本>.dmg" \
        root@121.89.85.150:/opt/aidcp/downloads/
      ```
- [ ] 旧版本文件可留可删（后台不再引用即无害）。

## 4. （已删除）改后台下载配置

**这一步没有了。** 下载页版本曾经写死在 `aidcp-console/src/config/downloads.ts` 里，可它描述的是「**这台机器的 downloads 目录里放了哪个包**」——一个每台机器各不相同的部署状态。写进源码，就保证了它对除了一台之外的所有机器都是谎话（主干指向 ol 的包 → dev 下载页死链；主干停在 dev 的包 → 部署 ol 时线上页回退）。

现在清单由云端现扫目录得出，**第 3 步把包传上去，页面下次打开就显示它**。不需要改代码、不需要重新构建部署 console、不需要提交任何版本号。

## 5. （已删除）重新构建并部署 console

同上：下载页不再随发版变化，无需重新构建部署。（console 本身有代码改动时才照常部署，与发版无关。）

## 6. 验活（HTTP，在 ECS 本机 curl :8088）

```bash
ssh -i ~/codes/dev-0722.pem root@121.89.85.150 '
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
- **CI 分发包已签名 + 公证**：mac 用户下载安装不再被 Gatekeeper 拦成「非法软件 / 无法验证开发者」，正常双击即可（首次仍可能有「从网络下载」的普通提示）。本机 unsigned 包不具备此性质，仅供自测。

---

## 附：CI 工作流要点（build-desktop.yml）

- **手动触发**（`workflow_dispatch`）；`macos-latest` 出签名+公证的 x64+arm64 dmg/zip；`include_windows=true` 时 `windows-latest` 才出 nsis exe（默认关，见 §2B）。产物作为 run artifact，保留 14 天。
- **输入 `cloud_default_env`（dev|ol）**：经 `-c.extraMetadata.aidcpCloudDefaultEnv` 注入打包 package.json，客户端「无界面选择、无启动环境变量」时据此连指定云（`ol`=装完默认连线上）。不注入=沿用客户端自身缺省 dev。
- **输入 `client_auth_url`（http(s)://.../capi）**：经 `-c.extraMetadata.aidcpClientAuthUrl` 注入打包 package.json，客户端启动即开启客户登录门。`cloud_default_env=ol` 且该输入留空时，workflow 默认使用 `https://aidcp.tommax.cc/capi`。
- **必须 `electron-builder --publish never`**（脚本内已强制）：CI 环境里 electron-builder 会自动尝试把产物发布到 GitHub release，缺 `GH_TOKEN` 直接报错。
- **mac 签名 / 公证**：`scripts/build-desktop-macos.sh` 先构建签名 `.app`（`forceCodeSigning` + hardened runtime + entitlements + 关内置 notarize），再用 `scripts/notarize-and-staple.sh` 显式 `notarytool` 公证 / staple `.app`，随后生成并公证 / staple dmg/zip，最后 Gatekeeper 校验。任一闸失败 → job 非零退出，绝不上传坏包。
- **自包含运行时进 CI**：build 前 `npm run build:ads-runtime`（stage 随包 AdsPower CLI）+ 从 `ADS_RUNTIME_JSON_BASE64` secret 还原 `resources/ads-runtime.json`（baked key），缺任一即诚实失败。
- **CI 产物 ≠ 下载地址**：14 天过期、私有仓要 GitHub 登录、是临时签名 URL、还套了一层 zip → **不能**直接挂后台，只能下载下来再转存到 ECS `/downloads/`（即第 3 步）。后台始终用自有服务器的固定地址。
- `gh` 本机已登录（含 `repo` 权限），可直接 `gh workflow run` / `gh run watch` / `gh run download`。

## 相关文档

- 部署铁律 / 生产机 / isales 红线：`../aidcp/CLAUDE.md` §5/§6。
- 后台下载清单来源：cloud `src/panel/downloads-manifest.ts`（现扫该机 downloads 目录）+ console `src/config/downloads.ts` 顶部注释。
- Nginx 下载 location：`aidcp-console/deploy/aidcp-console.conf`（`location /downloads/`）。

## Client auth defaults

Desktop clients require customer login by default for official cloud
environments. The default customer-auth URLs are:

- `dev`: `http://121.89.85.150:8088/capi`
- `ol`: `https://aidcp.tommax.cc/capi`

`AIDCP_CLIENT_AUTH_URL` or the workflow `client_auth_url` input still overrides
these defaults. Leaving the workflow input empty bakes the default URL for the
selected `cloud_default_env`.
