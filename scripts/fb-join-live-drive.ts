/**
 * fb-join-live-drive.ts — 用真实 FacebookJoinExecutor 在真机上跑一次「加群」端到端（task 0.1 点击腿验证）
 * ===========================================================================
 * 目的：验证作用域守卫改造后的**发货点击腿**在真实 FB 群页上：
 *   - 正确点到目标群自身的「加入小组」（在域内、非推荐位异群 join）；
 *   - 返回可信回执（joined / pending / not_ready …），绝不假成功。
 *
 * 安全闸：**必须带 --do-join 才真点**；不带则只 observe（click=false，零写）。
 *   只在测试账号 + 公开测试群上跑；跑完可用 --leave 退群复原（或手动退）。
 *
 * 运行：
 *   AIDCP_CDP_PORT=<port> tsx scripts/fb-join-live-drive.ts --url="https://www.facebook.com/groups/<id>/"            # 只观测
 *   AIDCP_CDP_PORT=<port> tsx scripts/fb-join-live-drive.ts --url="https://www.facebook.com/groups/<id>/" --do-join # 真加入
 */

import process from 'node:process';
import { writeFileSync } from 'node:fs';

import { attachToPage } from '../src/cdp/index.js';
import { FacebookJoinExecutor } from '../src/facebook/join-executor.js';

function readArg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : undefined;
}
const hasFlag = (n: string): boolean => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  const ts = Date.now();
  const host = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
  const port = Number(process.env.AIDCP_CDP_PORT ?? 9222);
  const url = readArg('url');
  if (!url) {
    console.error('必须 --url=<group url>');
    process.exit(1);
  }
  const doJoin = hasFlag('do-join');
  console.log(`[join-drive] start url=${url} doJoin=${doJoin} port=${port}`);

  const session = await attachToPage({ host, port, urlIncludes: 'facebook' });
  const exec = new FacebookJoinExecutor(
    { cdp: session.cdp, logger: (m) => console.log(`  ${m}`) },
    {},
  );
  const result = await exec.joinGroup(url, { click: doJoin });
  // 精简回执（去掉冗长 observation 里的大文本，仅留判定相关字段）
  const obs = result.observation ?? {};
  const post = result.postObservation ?? {};
  const slim = {
    ok: result.ok,
    reason: result.reason,
    clicked: result.clicked,
    groupUrl: result.groupUrl,
    observation: {
      targetGroupId: (obs as Record<string, unknown>).targetGroupId,
      scopeResolved: (obs as Record<string, unknown>).scopeResolved,
      outOfScopeJoinCount: (obs as Record<string, unknown>).outOfScopeJoinCount,
      joinCtaPresent: (obs as Record<string, unknown>).joinCtaPresent,
      pendingRequest: (obs as Record<string, unknown>).pendingRequest,
      mainCtaText: (obs as Record<string, unknown>).mainCtaText,
      membershipSignals: (obs as Record<string, unknown>).membershipSignals,
      ctaCandidates: (obs as Record<string, unknown>).ctaCandidates,
    },
    postObservation: {
      mainCtaText: (post as Record<string, unknown>).mainCtaText,
      scopeResolved: (post as Record<string, unknown>).scopeResolved,
      outOfScopeJoinCount: (post as Record<string, unknown>).outOfScopeJoinCount,
      membershipSignals: (post as Record<string, unknown>).membershipSignals,
    },
  };
  console.log('[join-drive] result', JSON.stringify(slim, null, 2));
  writeFileSync(`/tmp/aidcp-fb-join-drive-${ts}.json`, JSON.stringify({ ts, url, doJoin, result }, null, 2));
  console.log(`[join-drive] artifact /tmp/aidcp-fb-join-drive-${ts}.json`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[join-drive] fatal', e);
  process.exit(1);
});
