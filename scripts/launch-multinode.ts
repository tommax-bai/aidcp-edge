#!/usr/bin/env tsx
/**
 * launch-multinode.ts — 同机多节点启动器（编排留在 edge 核心之外，保持边缘薄）。
 *
 * 职责仅限「分配节点槽位 + 拉起」（account-identity-from-login 1.5：启动器**不再分配 accountId**，
 * 账号身份是「谁登进这个槽位」的产物，由 edge 在登录后从登录态读出）。每个节点槽位分配：
 *   - 独立调试端口   AIDCP_CDP_PORT       = base + i
 *   - 独立用户数据目录 AIDCP_CHROME_PROFILE = <profileBase>-node-<节点号>
 *   - 节点身份       AIDCP_EDGE_ID        = <edgeId | node-<节点号>>
 * 然后以这些环境变量拉起 N 个 `npm start` 子进程。edge 核心不含账号循环 / 进程池 / 编排逻辑。
 *
 * 用法（声明「要几个槽位」，不声明账号）：
 *   npm run start:multinode -- <N>                       # 起 N 个槽位：node-1 .. node-N
 *   npm run start:multinode -- <edgeId> [<edgeId> ...]   # 每个 token = 一个槽位的显式 edgeId
 *   AIDCP_NODES="3" npm run start:multinode              # 或经环境变量：个数
 *   AIDCP_NODES="edgeA,edgeB" npm run start:multinode    # 或：显式 edgeId 列表
 *
 * 端口/目录基址可覆盖：
 *   AIDCP_CDP_PORT_BASE=9222        # 节点 i 的端口 = base + i
 *   AIDCP_CHROME_PROFILE_BASE=~/.aidcp-chrome-profile
 *
 * 注意：
 *   - 每个节点独立调试端口 + 独立用户数据目录；不复用、不接管（子进程环境里清掉 AIDCP_CDP_ALLOW_REUSE）。
 *   - 身份来自登录：起槽位后，在各节点浏览器里扫码登想用的账号即可，启动器不指派 accountId。
 *     （如需预置/特殊场景显式指定身份，可在单独拉起某节点时设 AIDCP_ACCOUNT_ID 覆盖。）
 *   - 首次登录需各 profile 各登一次：建议先单独跑一个槽位（`AIDCP_CDP_PORT=... AIDCP_CHROME_PROFILE=... npm start`）
 *     在该 TTY 内完成扫码登录、建立持久 profile，之后再用本启动器并行拉起（子进程不持有 TTY/stdin）。
 *   - 【迁移代价】目录命名从旧的 `<base>-<accountId>-<n>` 改为 `<base>-node-<n>`：存量已登录 profile 按旧名
 *     找不到、会被迫重新扫码。cutover 须接受一次性重登，或先把旧目录改名为 `<base>-node-<n>` 迁移过去。
 *   - 本脚本只读外部注入，不触发任何云端写操作；不引入指纹浏览器（同机防关联非本次范围）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

interface NodeSlot {
  /** 显式 edgeId；缺省则用 node-<节点号>。 */
  edgeId?: string;
}

/**
 * 解析槽位规格：
 *   - 单个正整数 token → 起这么多个槽位（edgeId 缺省 node-<n>）；
 *   - 否则每个 token 当作一个槽位的显式 edgeId。
 */
function parseSlots(): NodeSlot[] {
  const tokens =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : (process.env.AIDCP_NODES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
    const n = Number(tokens[0]);
    return Array.from({ length: n }, () => ({}));
  }
  return tokens.map((token) => ({ edgeId: token.trim() || undefined }));
}

function prefixStream(child: ChildProcess, label: string): void {
  const pipe = (chunk: Buffer, out: NodeJS.WriteStream) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) out.write(`[${label}] ${line}\n`);
    }
  };
  child.stdout?.on('data', (c: Buffer) => pipe(c, process.stdout));
  child.stderr?.on('data', (c: Buffer) => pipe(c, process.stderr));
}

function main(): void {
  const slots = parseSlots();
  if (slots.length === 0) {
    console.error(
      '用法: npm run start:multinode -- <N>  或  <edgeId> [<edgeId> ...]  或设置 AIDCP_NODES="3" / "edgeA,edgeB"',
    );
    process.exit(2);
  }

  const basePort = Number(process.env.AIDCP_CDP_PORT_BASE ?? process.env.AIDCP_CDP_PORT ?? 9222);
  const profileBase = process.env.AIDCP_CHROME_PROFILE_BASE ?? join(homedir(), '.aidcp-chrome-profile');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

  const children: ChildProcess[] = [];
  slots.forEach((slot, i) => {
    const nodeNum = i + 1;
    const port = basePort + i;
    const edgeId = slot.edgeId ?? `node-${nodeNum}`;
    const profileDir = `${profileBase}-node-${nodeNum}`;
    const label = `node#${nodeNum}`;

    const env = { ...process.env };
    // 身份由登录读出：启动器不设 AIDCP_ACCOUNT_ID（清掉继承来的，避免误把某账号标签套到所有槽位）。
    delete env.AIDCP_ACCOUNT_ID;
    env.AIDCP_EDGE_ID = edgeId;
    env.AIDCP_CDP_PORT = String(port);
    env.AIDCP_CHROME_PROFILE = profileDir;
    // 每节点独立端口 + 独立目录：绝不允许复用 / 接管其它节点的浏览器。
    delete env.AIDCP_CDP_ALLOW_REUSE;

    console.log(`[launch-multinode] ${label}: edgeId=${edgeId} port=${port} profile=${profileDir}（账号待登录读出）`);
    const child = spawn('npm start', {
      cwd: repoRoot,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    prefixStream(child, label);
    child.on('exit', (code, signal) =>
      console.log(`[launch-multinode] ${label} 退出 (code=${code ?? ''} signal=${signal ?? ''})`),
    );
    children.push(child);
  });

  const shutdown = (sig: NodeJS.Signals) => {
    console.log(`[launch-multinode] 收到 ${sig}，停止全部节点…`);
    for (const c of children) c.kill(sig);
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
