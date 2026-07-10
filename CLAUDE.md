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

## 打包红线（Electron 桌面客户端）

> 这类 bug **只在打包版暴露，本地 `electron .` 与 typecheck / 单测都抓不到**，最容易发到运营机才发现。改 `src/electron/**` 的进程启动前必看。

- **spawn 的 `cwd` 与入口路径绝不能落进 `app.asar`**。打包态（electron-builder `asar:true`）下 `app.getAppPath()` 返回的是 `.../Contents/Resources/app.asar` 一个**文件**、不是目录；把它当 `cwd` 传给 `child_process.spawn`，macOS 直接抛 `spawn ENOTDIR`，核心子进程根本起不来、指纹浏览器无法启动。本地 dev 因 `appRoot` 是真目录不触发。
- **核心 spawn 的 cwd 守卫**：`const edgeCwd = appRoot.endsWith('.asar') ? path.dirname(appRoot) : appRoot;`（`dirname` = `Contents/Resources`，历史可跑通值）。新增任何子进程启动点都照此守卫；不传 `cwd` 的（继承主进程 cwd、绝非 asar）才安全。见 `src/electron/main.cjs` 的 `startEdge`。
- **打包类修复必须 forward-port 到 `master`**。本 bug 曾修于签名分支 `codex/edge-macos-developer-id-signing`（`20d3784`）却未合回 master，`0.3.5` 又把 regression 打包发出（复修 `3f578b9`，版本抬到 `0.3.6`）。只活在 feature 分支的打包 fix，一到 master 发版就复发。
- **发版前先在本机跑一遍打包产物**（起一次编译后的核心、确认能走到云端连接 / AdsPower 调用），别把 cwd/asar 类回归留给运营机。
