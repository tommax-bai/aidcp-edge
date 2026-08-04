import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fleet = require('../../src/electron/fleet.cjs');

// ---------------------------------------------------------------------------
// change stop-automation-only-on-authorization-loss
//
// 会话维护复核只以**授权事实**收敛自动化。「云端还不知道这个环境是谁」（未绑定 / 绑定读不到）
// 不是授权否定：绑定只回答「是谁」、不回答「归谁」，而未绑定环境本来就要靠下一次握手自愈。
//
// 这道闸的失效形态是「恒真」——写宽了界面上没有任何异常，只是再也拦不住撤权环境。所以判据
// 析出为纯函数，并逐输入钉死。
// ---------------------------------------------------------------------------

test('未绑定 / 绑定读不到 / 认不出的绑定态一律不收敛自动化', () => {
  for (const bindingState of ['binding_unknown', 'binding_unavailable', 'binding_future_state', '', undefined]) {
    assert.deepEqual(
      fleet.automationAuthorizationDecision({ ownedByCustomer: true, bindingState }),
      { converge: false, reason: null },
      `bindingState=${String(bindingState)} 不是授权否定，MUST NOT 停掉自动化`,
    );
  }
});

test('已绑定且仍在可见集内不收敛', () => {
  assert.deepEqual(
    fleet.automationAuthorizationDecision({ ownedByCustomer: true, bindingState: 'bound' }),
    { converge: false, reason: null },
  );
});

test('撤权即收敛，与绑定态无关', () => {
  for (const bindingState of ['bound', 'binding_unknown', 'binding_unavailable', undefined]) {
    assert.deepEqual(
      fleet.automationAuthorizationDecision({ ownedByCustomer: false, bindingState }),
      { converge: true, reason: 'ownership_revoked' },
    );
  }
});

test('跨客户绑定冲突即收敛，且与撤权原因可分辨', () => {
  assert.deepEqual(
    fleet.automationAuthorizationDecision({ ownedByCustomer: true, bindingState: 'binding_conflict' }),
    { converge: true, reason: 'binding_conflict' },
  );
  assert.deepEqual(
    fleet.automationAuthorizationDecision({ ownedByCustomer: true, bindingState: 'environment_not_owned' }),
    { converge: true, reason: 'ownership_revoked' },
  );
});

test('缺参数按最保守解读：没有归属证据即收敛', () => {
  assert.deepEqual(
    fleet.automationAuthorizationDecision(),
    { converge: true, reason: 'ownership_revoked' },
  );
});
