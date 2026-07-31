import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { NativePageRuntime, type NativePageEndpoint } from '../../src/native-page-engine/runtime.js';

/**
 * 宿主这一半的重连绑定契约（`harden-native-engine-runtime-contracts` 6.1–6.3）。
 *
 * 危害本身在引擎侧：同机多环境并行时，指纹浏览器释放的调试端口会被另一个环境复用，
 * 重连若只按端口挑目标就可能附着到别人的浏览器上。引擎能挡住它，靠的是宿主交付的两样东西：
 *  ① 开会话时把**这一个浏览器实例的身份证据**交过去（重连时的比对基线）；
 *  ② 会话期内**可重复取值**的端点解析入口（浏览器换了端口还能找回去）。
 *
 * 这两样都是纯粹的「线路是否接上」，引擎侧的 Rust 用例一条都看不到 ——
 * 中间任何一环把值丢了，引擎只会看到「没有基线」并诚实拒绝重连，而 Rust 那边照样全绿。
 */

const fixture = fileURLToPath(
  new URL('../fixtures/native-page-engine/runtime-contract-engine.mjs', import.meta.url),
);

const manifest = {
  engineVersion: 'runtime-contract-test',
  platformAdapterVersion: 'multi-platform-test',
  platformAdapters: [
    { platform: 'xiaohongshu' as const, adapterVersion: 'xiaohongshu-test' },
    { platform: 'facebook' as const, adapterVersion: 'facebook-test' },
    { platform: 'wechat_channels' as const, adapterVersion: 'wechat-channels-test' },
  ],
  capabilityDigest: 'b'.repeat(64),
};

interface EndpointEcho {
  host: string | null;
  port: number | null;
  admittedBrowserDebuggerUrl: string | null;
}

test('准入证据与端点解析：身份随开会话交付，端点在会话期内按需重新解析', async () => {
  // 「浏览器换了一代」：端口与实例标识一起换掉，正是冷待机唤醒后的形态。
  let generation: NativePageEndpoint = {
    host: '127.0.0.1',
    port: 9222,
    browserDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/first-generation',
  };
  let resolveCalls = 0;
  const engine = new NativePageRuntime({
    binaryPath: process.execPath,
    binaryArgs: [fixture],
    processTimeoutMs: 4_000,
    expectedManifest: manifest,
    platform: 'xiaohongshu',
    getEndpoint: () => {
      resolveCalls += 1;
      return generation;
    },
    env: { AIDCP_RUNTIME_CONTRACT_ENGINE_MODE: 'endpoint-request' },
  });

  try {
    await engine.openOwner('browse:endpoint');
    assert.equal(resolveCalls, 1, '建会话取一次端点');

    // 会话已经开着的时候浏览器被重开：新端口、新实例标识。
    generation = {
      host: '127.0.0.1',
      port: 61332,
      browserDebuggerUrl: 'ws://127.0.0.1:61332/devtools/browser/second-generation',
    };

    const execution = await engine.execute(
      'browse:endpoint',
      { kind: 'browse_scroll', params: { reason: 'reconnect' } },
      3_000,
    );
    assert.equal(execution.ok, true);
    const receipt = execution.output?.value as { reason?: string } | undefined;
    const echo = JSON.parse(String(receipt?.reason ?? '{}')) as EndpointEcho;

    // ① 身份证据必须原样到达引擎，且是**开会话那一刻**那一代的
    //    （它是比对基线，不能被后来的解析结果顶掉）。
    assert.equal(
      echo.admittedBrowserDebuggerUrl,
      'ws://127.0.0.1:9222/devtools/browser/first-generation',
      '准入证据必须随开会话交付给引擎；这条线路上任何一环丢了它，引擎就只能拒绝一切重连',
    );

    // ② 端点解析必须是**此刻**的答案，不是建会话时冻住的那一份。
    assert.equal(resolveCalls, 2, '重连时必须再向宿主解析一次端点');
    assert.equal(echo.port, 61332, '重连拿到的必须是当代端口，而不是建会话时那个');
    assert.equal(echo.host, '127.0.0.1');
  } finally {
    await engine.shutdown().catch(() => undefined);
  }
});

test('端点解析不出来时如实回空，绝不把上一次的端口原样回填', async () => {
  const engine = new NativePageRuntime({
    binaryPath: process.execPath,
    binaryArgs: [fixture],
    processTimeoutMs: 4_000,
    expectedManifest: manifest,
    platform: 'xiaohongshu',
    getEndpoint: (() => {
      let opened = false;
      return () => {
        if (opened) {
          // 浏览器已经不在了：提供方给不出端点。回填上一次那个端口正是危害的入口 ——
          // 它此刻可能已经属于同机另一个环境的浏览器。
          throw new Error('browser generation is gone');
        }
        opened = true;
        return {
          host: '127.0.0.1',
          port: 9222,
          browserDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/only-generation',
        };
      };
    })(),
    env: { AIDCP_RUNTIME_CONTRACT_ENGINE_MODE: 'endpoint-request' },
  });

  try {
    await engine.openOwner('browse:gone');
    const execution = await engine.execute(
      'browse:gone',
      { kind: 'browse_scroll', params: { reason: 'reconnect' } },
      3_000,
    );
    const receipt = execution.output?.value as { reason?: string } | undefined;
    const echo = JSON.parse(String(receipt?.reason ?? '{}')) as EndpointEcho;
    assert.equal(echo.host, null, '解析不出来就必须回空端点');
    assert.equal(echo.port, null, '绝不允许把上一次的端口当作答案回填');
  } finally {
    await engine.shutdown().catch(() => undefined);
  }
});
