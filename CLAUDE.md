# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本仓是 **aidcp\*** 家族的一员（边缘端 CDP / 定位 / 浏览 / 发布 / Electron）。家族级契约、架构与完整工作约定以中控仓 `../aidcp/CLAUDE.md` 为权威；本文件只固化「跨仓通用、需随 git 换机器仍生效」的沟通偏好，确保在本仓直接工作时也加载。

## 沟通方式（默认模式，用户偏好）

- **问题 / 根因 / 方案的说明方式**：讲逻辑、讲因果，**不用比喻**；**不点代码内部标识符**（变量 / 类 / 函数 / 消息类型名），改用**功能性正文**描述组件与机制（如「执行端 / 决策端 / 监测体」「发命令给执行端的统一出口」「会话凭证失效后的统一兜底」）。
- 分点、句子短，让非工程视角也能跟上；确需落到代码时再补具体 `文件:行`，且放在解释之后。诊断阶段重逻辑，实现阶段才落到具体文件。
- 正文默认中文；代码 / 注释 / commit / PR / 命令 / 文件名保持英文。

## 提交 / 推送 / 部署

- **提交 / 推送 / 部署默认直接做、不用逐次问**（用户长期授权，2026-06-27）。推默认分支 `master`；commit message 末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 部署形态与安全序列、isales 红线、生产机访问细节，以中控仓 `../aidcp/CLAUDE.md` §5/§6 为权威。

## Native 页面引擎（编译进二进制的页面规则）

> 页面规则（探针 / 路由分片 / 选择器）在构建期被逐字节异或编码后编进 Rust 二进制，运行时再解回来。
> 这一节的四条法条都属同一个失效族：**本地全绿、单测照过，只有真跑一次页面命令才现形**——
> 而那时拿到的现场（一段乱码 / 一句「结果无效」/ 一个空结果）与「平台改版了」**完全无法区分**，
> 会把人往完全错误的方向带。改 `native/page-engine/**` 前必看。

### 这层编码不是保密，别当保密用

- **它只挡扫读级别的窥探。** 密钥与算法都随二进制一起发出去，**拿到安装包即可还原**，
  对任何愿意花十分钟的人都不构成障碍。
- **MUST NOT 因为「规则已加密」就把凭据 / 令牌 / 可访问远端系统的密钥塞进同一条通道。**
  能进这条通道的只有页面规则本身。需要保密的东西，通道选型要另外论证。
- 密钥的**唯一定义**在 `native/page-engine/src/embedded_asset_key.rs`；编码端（`build.rs`）与
  全部解码端共用它。曾经四处各写一份，四份一致时谁也看不出问题，**改一份就炸在运行时**。

### 四条「只有真跑页面命令才现形」的法条

1. **新增嵌入资产必须同时改两处**：构建脚本里的读取，以及 `cargo:rerun-if-changed` 声明。
   只改读取不加声明，改了资产不会触发重新编码——**运行时拿新密钥去解旧资产**。
   （密钥文件本身也在此列：它被 `include!` 进 `build.rs`，必须显式声明。）
2. **新增分片必须同时登记进清单。** 没登记的分片不会被拼进产物，页面上表现为「这个动作什么都没做」。
3. **分片命名的词典序就是执行结构序。** 新分片的命名 MUST 排在依赖它的分片之前，
   否则拼接顺序里被依赖者后出现，运行时报的是「未定义」而不是「顺序错了」。
4. **改页面规则后，开发态必须由源码摘要强制重编。** 产物校验若只比对哈希与清单，
   摸过源码但没重建时会输出「已校验」并跳过重建——**你以为在测新规则，跑的是旧产物**。

## 打包红线（Electron 桌面客户端）

> 这类 bug **只在打包版暴露，本地 `electron .` 与 typecheck / 单测都抓不到**，最容易发到运营机才发现。改 `src/electron/**` 的进程启动前必看。

- **spawn 的 `cwd` 与入口路径绝不能落进 `app.asar`**。打包态（electron-builder `asar:true`）下 `app.getAppPath()` 返回的是 `.../Contents/Resources/app.asar` 一个**文件**、不是目录；把它当 `cwd` 传给 `child_process.spawn`，macOS 直接抛 `spawn ENOTDIR`，核心子进程根本起不来、指纹浏览器无法启动。本地 dev 因 `appRoot` 是真目录不触发。
- **核心 spawn 的 cwd 守卫**：`const edgeCwd = appRoot.endsWith('.asar') ? path.dirname(appRoot) : appRoot;`（`dirname` = `Contents/Resources`，历史可跑通值）。新增任何子进程启动点都照此守卫；不传 `cwd` 的（继承主进程 cwd、绝非 asar）才安全。见 `src/electron/main.cjs` 的 `startEdge`。
- **打包类修复必须 forward-port 到 `master`**。本 bug 曾修于签名分支 `codex/edge-macos-developer-id-signing`（`20d3784`）却未合回 master，`0.3.5` 又把 regression 打包发出（复修 `3f578b9`，版本抬到 `0.3.6`）。只活在 feature 分支的打包 fix，一到 master 发版就复发。
- **发版前先在本机跑一遍打包产物**（起一次编译后的核心、确认能走到云端连接 / AdsPower 调用），别把 cwd/asar 类回归留给运营机。
