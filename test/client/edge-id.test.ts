import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEdgeId } from '../../src/client/edge-id.js';

const HOST = () => 'box42';

test('显式 AIDCP_EDGE_ID 优先（逃生阀 / launch-multinode 注入）', () => {
  const d = deriveEdgeId({ AIDCP_EDGE_ID: 'node-1', AIDCP_ADS_USER_ID: 'k1', AIDCP_CHROME_PROFILE: '/p' }, HOST);
  assert.equal(d.edgeId, 'node-1');
  assert.equal(d.source, 'env-override');
  assert.equal(d.warning, undefined);
});

test('显式值去空白后为空 → 视作未设，继续按隔离边界派生', () => {
  const d = deriveEdgeId({ AIDCP_EDGE_ID: '   ', AIDCP_ADS_USER_ID: 'k1e0awu5' }, HOST);
  assert.equal(d.edgeId, 'ads-k1e0awu5');
  assert.equal(d.source, 'adspower-profile');
});

test('分身浏览器：用分身 id 派生 ads-<profileId>（与 launch-multinode 同公式）', () => {
  const d = deriveEdgeId({ AIDCP_ADS_USER_ID: 'k1e0awu5' }, HOST);
  assert.equal(d.edgeId, 'ads-k1e0awu5');
  assert.equal(d.source, 'adspower-profile');
  assert.equal(d.warning, undefined);
});

test('分身 id 优先于 user-data-dir（默认 adspower 路径）', () => {
  const d = deriveEdgeId({ AIDCP_ADS_USER_ID: 'k1', AIDCP_CHROME_PROFILE: '/home/u/.aidcp-chrome-profile-node-2' }, HOST);
  assert.equal(d.edgeId, 'ads-k1');
  assert.equal(d.source, 'adspower-profile');
});

test('自起浏览器：用 user-data-dir 末段派生 self-<dir>', () => {
  const d = deriveEdgeId({ AIDCP_CHROME_PROFILE: '/home/u/.aidcp-chrome-profile-node-2' }, HOST);
  assert.equal(d.edgeId, 'self-.aidcp-chrome-profile-node-2');
  assert.equal(d.source, 'self-profile-dir');
  assert.equal(d.warning, undefined);
});

test('self user-data-dir 结尾带分隔符也取到正确末段', () => {
  const d = deriveEdgeId({ AIDCP_CHROME_PROFILE: '/home/u/profile-A/' }, HOST);
  assert.equal(d.edgeId, 'self-profile-A');
});

test('兜底：无任何隔离边界 → host-<主机名> + 告警，绝不回落共享常量', () => {
  const d = deriveEdgeId({}, HOST);
  assert.equal(d.edgeId, 'host-box42');
  assert.equal(d.source, 'hostname-fallback');
  assert.ok(d.warning && d.warning.includes('AIDCP_EDGE_ID'), '兜底必须提醒显式设 AIDCP_EDGE_ID');
});

test('绝不回落旧的共享常量 edge-local（回归守卫）', () => {
  for (const env of [{}, { AIDCP_ADS_USER_ID: 'x' }, { AIDCP_CHROME_PROFILE: '/p' }] as NodeJS.ProcessEnv[]) {
    assert.notEqual(deriveEdgeId(env, HOST).edgeId, 'edge-local');
  }
});

test('不同分身 → 不同 edgeId（根除互踢的核心不变量：唯一）', () => {
  const a = deriveEdgeId({ AIDCP_ADS_USER_ID: 'k1e0awu5' }, HOST).edgeId; // Tmax
  const b = deriveEdgeId({ AIDCP_ADS_USER_ID: 'k1e0ero8' }, HOST).edgeId; // 工程师大白
  assert.notEqual(a, b);
});

test('同分身重复派生 → 同 edgeId（保住同节点重连顶替的核心不变量：稳定）', () => {
  const a = deriveEdgeId({ AIDCP_ADS_USER_ID: 'k1e0awu5' }, HOST).edgeId;
  const b = deriveEdgeId({ AIDCP_ADS_USER_ID: 'k1e0awu5' }, HOST).edgeId;
  assert.equal(a, b);
});
