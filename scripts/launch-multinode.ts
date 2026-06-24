#!/usr/bin/env tsx
/**
 * launch-multinode.ts — 同机多节点启动器（编排留在 edge 核心之外，保持边缘薄）。
 *
 * 职责仅限「分配 + 拉起」：为每个节点分配
 *   - 独立调试端口   AIDCP_CDP_PORT       = base + i
 *   - 独立用户数据目录 AIDCP_CHROME_PROFILE = <profileBase>-<accountId>-<节点号>
 *   - 真实账号身份   AIDCP_ACCOUNT_ID     = <accountId>   （每个节点必须显式声明，含 default）
 *   - 节点身份       AIDCP_EDGE_ID        = <edgeId | accountId-n<节点号>>
 * 然后以这些环境变量拉起 N 个 `npm start` 子进程。edge 核心不含账号循环 / 进程池 / 编排逻辑。
 *
 * 用法：
 *   npm run start:multinode -- <accountId>[:<edgeId>] [<accountId>[:<edgeId>] ...]
 *   # 或经环境变量（逗号分隔）：
 *   AIDCP_NODES="default,acc2,acc3:edgeB" npm run start:multinode
 *
 * 端口/目录基址可覆盖：
 *   AIDCP_CDP_PORT_BASE=9222        # 节点 i 的端口 = base + i
 *   AIDCP_CHROME_PROFILE_BASE=~/.aidcp-chrome-profile
 *
 * 注意：
 *   - 每个节点独立调试端口 + 独立用户数据目录；不复用、不接管（子进程环境里清掉 AIDCP_CDP_ALLOW_REUSE）。
 *   - 首次登录需各 profile 各登一次：建议先单独跑一个节点（`AIDCP_ACCOUNT_ID=... AIDCP_CDP_PORT=... AIDCP_CHROME_PROFILE=... npm start`）
 *     在该 TTY 内完成扫码登录、建立持久 profile，之后再用本启动器并行拉起（子进程不持有 TTY/stdin）。
 *   - 本脚本只读外部注入，不触发任何云端写操作；不引入指纹浏览器（同机防关联非本次范围）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

interface NodeSpec {
  accountId: string;
  edgeId?: string;
}

function parseSpecs(): NodeSpec[] {
  const raw =
    process.argv.slice(2).length > 0
      ? process.argv.slice(2)
      : (process.env.AIDCP_NODES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.map((token) => {
    const [accountId, edgeId] = token.split(':');
    return { accountId: (accountId ?? '').trim(), edgeId: edgeId?.trim() || undefined };
  });
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
  const specs = parseSpecs();
  if (specs.length === 0) {
    console.error(
      '用法: npm run start:multinode -- <accountId>[:<edgeId>] [...]  或设置 AIDCP_NODES="acc1,acc2:edgeB"',
    );
    process.exit(2);
  }
  const bad = specs.filter((s) => !s.accountId);
  if (bad.length > 0) {
    console.error('每个节点必须声明非空 accountId（含默认账号须显式写 default）。');
    process.exit(2);
  }

  const basePort = Number(process.env.AIDCP_CDP_PORT_BASE ?? process.env.AIDCP_CDP_PORT ?? 9222);
  const profileBase = process.env.AIDCP_CHROME_PROFILE_BASE ?? join(homedir(), '.aidcp-chrome-profile');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

  const children: ChildProcess[] = [];
  specs.forEach((spec, i) => {
    const nodeNum = i + 1;
    const port = basePort + i;
    const edgeId = spec.edgeId ?? `${spec.accountId}-n${nodeNum}`;
    const profileDir = `${profileBase}-${spec.accountId}-${nodeNum}`;
    const label = `node:${spec.accountId}#${nodeNum}`;

    const env = { ...process.env };
    env.AIDCP_ACCOUNT_ID = spec.accountId;
    env.AIDCP_EDGE_ID = edgeId;
    env.AIDCP_CDP_PORT = String(port);
    env.AIDCP_CHROME_PROFILE = profileDir;
    // 每节点独立端口 + 独立目录：绝不允许复用 / 接管其它节点的浏览器。
    delete env.AIDCP_CDP_ALLOW_REUSE;

    console.log(
      `[launch-multinode] ${label}: account=${spec.accountId} edgeId=${edgeId} port=${port} profile=${profileDir}`,
    );
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
