#!/usr/bin/env tsx
/**
 * launch-multinode.ts — 同机多节点启动器 + 看护进程（编排留在 edge 核心之外，保持边缘薄）。
 *
 * 职责：「分配节点槽位 + 拉起 + 看护」（account-identity-from-login 1.5：启动器**不再分配 accountId**，
 * 账号身份是「谁登进这个槽位」的产物，由 edge 在登录后从登录态读出）。每个节点槽位分配：
 *   - 独立调试端口   AIDCP_CDP_PORT       = base + i
 *   - 独立用户数据目录 AIDCP_CHROME_PROFILE = <profileBase>-node-<节点号>
 *   - 节点身份       AIDCP_EDGE_ID        = <edgeId | node-<节点号>>
 * 然后拉起 N 个 edge 子进程并**看护**：节点以「请重起」语义（非零退出码）退出时，按**固定槽位**
 * （端口/目录/edgeId 全不变）有界重起 + 指数退避 + 连续失败诚实放弃（edge-own-chrome-supervised-recycle）。
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
 * 看护参数（缺省合理，可覆盖）：
 *   AIDCP_EDGE_RESPAWN_MAX=5                  # 连续失败上限，到顶诚实放弃
 *   AIDCP_EDGE_RESPAWN_BACKOFF_BASE_MS=1000   # 退避基数
 *   AIDCP_EDGE_RESPAWN_BACKOFF_MAX_MS=30000   # 退避上限
 *   AIDCP_EDGE_RESPAWN_HEALTHY_UPTIME_MS=60000# 健康存活达此时长 → 连续失败计数清零
 *   AIDCP_EDGE_CHILD_LOGIN_TIMEOUT_MS=45000   # 注入子进程的登录等待上限（headless 无扫码，登录态应秒级命中）
 *
 * 信号/进程模型（关键）：
 *   - 子进程**直接 spawn tsx 执行体**（不经 npm/shell 外壳层），且 detached:true 自成进程组。
 *     停止/重起对**整个进程组**发信号（process.kill(-pid)）→ 信号必达执行体及其自启 Chrome，
 *     执行体的关机路径（唯一真杀 Chrome 处）必然运行 → 零孤儿 edge / 零孤儿 Chrome、不残留霸占端口+锁。
 *   - 看护进程收到 SIGINT/SIGTERM → 置「正在关机」，子进程退出处**无条件抑制重起**（关机优先）。
 *
 * 注意：
 *   - 每个节点独立调试端口 + 独立用户数据目录；不复用、不接管（子进程环境里清掉 AIDCP_CDP_ALLOW_REUSE，
 *     且按固定槽位**冻结 env 快照**，重起复用同一快照、绝不重新展开活 env，防复用开关漂移泄漏）。
 *   - 身份来自登录：起槽位后，在各节点浏览器里扫码登想用的账号即可，启动器不指派 accountId。
 *     （如需预置/特殊场景显式指定身份，可在单独拉起某节点时设 AIDCP_ACCOUNT_ID 覆盖。）
 *   - 首次登录需各 profile 各登一次：建议先单独跑一个槽位（`AIDCP_CDP_PORT=... AIDCP_CHROME_PROFILE=... npm start`）
 *     在该 TTY 内完成扫码登录、建立持久 profile，之后再用本启动器并行拉起（子进程不持有 TTY/stdin）。
 *   - 【迁移代价】目录命名 `<base>-node-<n>`：存量旧名 `<base>-<accountId>-<n>` 的 profile 按新名找不到、会被迫重新扫码。
 *   - 本脚本只读外部注入，不触发任何云端写操作；不引入指纹浏览器（同机防关联非本次范围）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { decideRespawn } from '../src/supervise/respawn-policy.js';

interface NodeSlot {
  /** 显式 edgeId；缺省则用 node-<节点号>。 */
  edgeId?: string;
}

/** 单槽位冻结计划：env 快照在启动时定型，重起按固定 index 复用（绝不重新展开活 env）。 */
interface NodePlan {
  index: number;
  label: string;
  env: NodeJS.ProcessEnv;
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
  const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');

  // 看护参数
  const RESPAWN_MAX = Number(process.env.AIDCP_EDGE_RESPAWN_MAX ?? 5);
  const BACKOFF_BASE_MS = Number(process.env.AIDCP_EDGE_RESPAWN_BACKOFF_BASE_MS ?? 1_000);
  const BACKOFF_MAX_MS = Number(process.env.AIDCP_EDGE_RESPAWN_BACKOFF_MAX_MS ?? 30_000);
  const HEALTHY_UPTIME_MS = Number(process.env.AIDCP_EDGE_RESPAWN_HEALTHY_UPTIME_MS ?? 60_000);
  const CHILD_LOGIN_TIMEOUT_MS = process.env.AIDCP_EDGE_CHILD_LOGIN_TIMEOUT_MS ?? '45000';

  // 1) 冻结每槽位计划：env 快照按固定槽位定型（端口/目录/edgeId），重起复用同一快照。
  const plans: NodePlan[] = slots.map((slot, i) => {
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
    // 独占：绝不复用 / 接管其它节点或外部浏览器（冻结进快照，重起不会漂移泄漏）。
    delete env.AIDCP_CDP_ALLOW_REUSE;
    // 收紧子进程登录等待：无 TTY 无从扫码，登录态丢失则按崩溃快速计入重起预算，不干等 5min。
    env.AIDCP_CHROME_LOGIN_TIMEOUT_MS = CHILD_LOGIN_TIMEOUT_MS;
    return { index: i, label, env };
  });

  let shuttingDown = false;
  const children = new Map<number, ChildProcess>();
  const failStreak = new Map<number, number>();
  const startedAt = new Map<number, number>();

  const spawnNode = (plan: NodePlan): void => {
    if (shuttingDown) return;
    console.log(
      `[launch-multinode] ${plan.label}: 启动 port=${plan.env.AIDCP_CDP_PORT} profile=${plan.env.AIDCP_CHROME_PROFILE} edgeId=${plan.env.AIDCP_EDGE_ID}（账号待登录读出）`,
    );
    // 直接 spawn tsx 执行体（无 npm/shell 外壳层）+ detached 自成进程组：信号可整组送达。
    const child = spawn(tsxBin, ['src/main.ts'], {
      cwd: repoRoot,
      env: plan.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.set(plan.index, child);
    startedAt.set(plan.index, Date.now());
    prefixStream(child, plan.label);
    child.on('exit', (code, signal) => {
      children.delete(plan.index);
      console.log(`[launch-multinode] ${plan.label} 退出 (code=${code ?? ''} signal=${signal ?? ''})`);
      // 重起决策收口纯函数（连续失败计数 + 健康清零 + 退避 + 诚实放弃，见 respawn-policy.ts）。
      const uptimeMs = Date.now() - (startedAt.get(plan.index) ?? Date.now());
      const decision = decideRespawn(
        { exitCode: code, uptimeMs, prevStreak: failStreak.get(plan.index) ?? 0, shuttingDown },
        {
          maxConsecutiveFailures: RESPAWN_MAX,
          backoffBaseMs: BACKOFF_BASE_MS,
          backoffMaxMs: BACKOFF_MAX_MS,
          healthyUptimeMs: HEALTHY_UPTIME_MS,
        },
      );
      failStreak.set(plan.index, decision.streak);
      if (decision.action === 'stop') {
        // 关机优先（MAJOR⑤）或干净退出（code=0，节点诚实终止）→ 不重起。
        if (!shuttingDown && code === 0) console.log(`[launch-multinode] ${plan.label} 干净退出（code=0），不重起`);
        return;
      }
      if (decision.action === 'give-up') {
        console.error(
          `[launch-multinode] ✗ ${plan.label} 连续失败达上限（${RESPAWN_MAX}）后仍失败 → 诚实放弃：留该节点下线，兄弟节点继续运行。请人工排查（登录态/端口/配置）后重启该节点。`,
        );
        return;
      }
      console.warn(
        `[launch-multinode] ${plan.label} 非零退出 → ${decision.delayMs}ms 后第 ${decision.streak}/${RESPAWN_MAX} 次重起`,
      );
      const t = setTimeout(() => spawnNode(plan), decision.delayMs);
      (t as { unref?: () => void }).unref?.();
    });
  };

  plans.forEach(spawnNode);

  const shutdown = (sig: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[launch-multinode] 收到 ${sig}，停止全部节点（关机优先、不再重起）…`);
    for (const child of children.values()) {
      try {
        // 整组 kill：detached 子为组长，-pid 即整组（执行体 + 其 Chrome + tsx/esbuild），信号必达、零孤儿。
        if (typeof child.pid === 'number') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* ignore */
        }
      }
    }
    // 给各子进程的异步关机（诚实下线 closeAndWait + 确认 Chrome 死 killAndConfirmDead）留时间再退。
    const t = setTimeout(() => process.exit(0), 6_000);
    (t as { unref?: () => void }).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
