import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

type Resolved = {
  ok: boolean;
  error?: string;
  runMode?: string | null;
  facebookOperationMode?: string | null;
  slowStartEnabled?: boolean;
  facebookRuleModeEnabled?: boolean;
  commentApprovalMode?: string | null;
};

const { resolveFacebookCreationIntents } = require('../../src/electron/facebook-create-intents.cjs') as {
  resolveFacebookCreationIntents: (input: {
    platform?: string;
    opts?: Record<string, unknown>;
  }) => Resolved;
};

test('运行方式四选一翻译成一个 Cloud operation mode，且兼容布尔事实永不同时开启', () => {
  const normal = resolveFacebookCreationIntents({ platform: 'facebook', opts: { facebookRunMode: 'normal' } });
  assert.equal(normal.ok, true);
  assert.equal(normal.facebookOperationMode, 'persona');
  assert.equal(normal.slowStartEnabled, false);
  assert.equal(normal.facebookRuleModeEnabled, false);
  assert.equal(normal.commentApprovalMode, null);

  const cold = resolveFacebookCreationIntents({ platform: 'facebook', opts: { facebookRunMode: 'cold_start' } });
  assert.equal(cold.ok, true);
  assert.equal(cold.facebookOperationMode, 'slow_start');
  assert.equal(cold.slowStartEnabled, true);
  assert.equal(cold.facebookRuleModeEnabled, false);

  const rule = resolveFacebookCreationIntents({ platform: 'facebook', opts: { facebookRunMode: 'rule' } });
  assert.equal(rule.ok, true);
  assert.equal(rule.facebookOperationMode, 'rule');
  assert.equal(rule.slowStartEnabled, false);
  assert.equal(rule.facebookRuleModeEnabled, true);

  const consumption = resolveFacebookCreationIntents({
    platform: 'facebook',
    opts: { facebookRunMode: 'consumption' },
  });
  assert.equal(consumption.ok, true);
  assert.equal(consumption.runMode, 'consumption');
  assert.equal(consumption.facebookOperationMode, 'consumption');
  assert.equal(consumption.slowStartEnabled, false);
  assert.equal(consumption.facebookRuleModeEnabled, false);

  for (const resolved of [normal, cold, rule, consumption]) {
    assert.equal(resolved.slowStartEnabled === true && resolved.facebookRuleModeEnabled === true, false);
  }
});

test('Facebook 创建默认既不开慢启动也不开规则模式（旧的写死默认已撤销）', () => {
  const resolved = resolveFacebookCreationIntents({ platform: 'facebook', opts: {} });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.runMode, 'normal');
  assert.equal(resolved.facebookOperationMode, 'persona');
  assert.equal(resolved.slowStartEnabled, false);
  assert.equal(resolved.facebookRuleModeEnabled, false);
  assert.equal(resolved.commentApprovalMode, null, '免审默认关闭：不下发该字段');
});

test('绕过界面同时携带慢启动与规则模式开启意图 → 整请求拒绝，不静默丢弃其中一项', () => {
  const resolved = resolveFacebookCreationIntents({
    platform: 'facebook',
    opts: { slowStartEnabled: true, facebookRuleModeEnabled: true },
  });
  assert.equal(resolved.ok, false);
  assert.match(String(resolved.error), /不能同时开启/);
  assert.equal(resolved.slowStartEnabled, undefined);
  assert.equal(resolved.facebookRuleModeEnabled, undefined);
});

test('运行方式与单项意图自相矛盾 → 拒绝，不替调用方猜一边执行', () => {
  const coldPlusRule = resolveFacebookCreationIntents({
    platform: 'facebook',
    opts: { facebookRunMode: 'cold_start', facebookRuleModeEnabled: true },
  });
  assert.equal(coldPlusRule.ok, false);
  assert.match(String(coldPlusRule.error), /规则模式意图互相矛盾/);

  const rulePlusSlow = resolveFacebookCreationIntents({
    platform: 'facebook',
    opts: { facebookRunMode: 'rule', slowStartEnabled: true },
  });
  assert.equal(rulePlusSlow.ok, false);
  assert.match(String(rulePlusSlow.error), /慢启动意图互相矛盾/);

  const consistent = resolveFacebookCreationIntents({
    platform: 'facebook',
    opts: { facebookRunMode: 'cold_start', slowStartEnabled: true, facebookRuleModeEnabled: false },
  });
  assert.equal(consistent.ok, true);
  assert.equal(consistent.slowStartEnabled, true);
  assert.equal(consistent.facebookRuleModeEnabled, false);
});

test('非 Facebook 平台携带任一运行方式或免审意图 → 整请求拒绝（不靠渲染层隐藏兜底）', () => {
  for (const opts of [
    { facebookRunMode: 'normal' },
    { facebookRunMode: 'cold_start' },
    { slowStartEnabled: true },
    { facebookRuleModeEnabled: true },
    { commentApprovalMode: 'auto_approve_all' },
  ]) {
    for (const platform of ['xiaohongshu', 'wechat_channels']) {
      const resolved = resolveFacebookCreationIntents({ platform, opts });
      assert.equal(resolved.ok, false, `${platform} + ${JSON.stringify(opts)} 应被拒绝`);
      assert.match(String(resolved.error), /只有 Facebook 环境/);
    }
  }
});

test('非 Facebook 平台不带这些键时照常放行，且不携带任何配置意图', () => {
  const resolved = resolveFacebookCreationIntents({
    platform: 'xiaohongshu',
    opts: { creationMode: 'single', osFamilyKey: 'windows' },
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.runMode, null);
  assert.equal(resolved.facebookOperationMode, null);
  assert.equal(resolved.slowStartEnabled, false);
  assert.equal(resolved.facebookRuleModeEnabled, false);
  assert.equal(resolved.commentApprovalMode, null);
});

test('免审与运行方式相互独立：任一运行方式下都可勾选', () => {
  for (const runMode of ['normal', 'cold_start', 'rule', 'consumption']) {
    const resolved = resolveFacebookCreationIntents({
      platform: 'facebook',
      opts: { facebookRunMode: runMode, commentApprovalMode: 'auto_approve_all' },
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.runMode, runMode);
    assert.equal(resolved.commentApprovalMode, 'auto_approve_all');
  }
});

test('免审取值只认既定两种；按来源规则等同于不下发；未知取值整请求拒绝', () => {
  const sourceRules = resolveFacebookCreationIntents({
    platform: 'facebook',
    opts: { facebookRunMode: 'normal', commentApprovalMode: 'source_rules' },
  });
  assert.equal(sourceRules.ok, true);
  assert.equal(sourceRules.commentApprovalMode, null, '按来源规则不下发字段');

  const bogus = resolveFacebookCreationIntents({
    platform: 'facebook',
    opts: { commentApprovalMode: 'approve_everything' },
  });
  assert.equal(bogus.ok, false);
  assert.match(String(bogus.error), /全局免审意图取值无法识别/);
});

test('运行方式非法枚举与非布尔单项意图都整请求拒绝', () => {
  const badMode = resolveFacebookCreationIntents({ platform: 'facebook', opts: { facebookRunMode: 'turbo' } });
  assert.equal(badMode.ok, false);
  assert.match(String(badMode.error), /普通、冷启动、规则或消费/);

  const badBoolean = resolveFacebookCreationIntents({ platform: 'facebook', opts: { slowStartEnabled: 'true' } });
  assert.equal(badBoolean.ok, false);
  assert.match(String(badBoolean.error), /只接受开或关/);
});
