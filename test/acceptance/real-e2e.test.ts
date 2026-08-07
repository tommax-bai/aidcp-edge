/**
 * 验收用例 AC-E2E-* — 本地真机联调（边缘视角，gated）
 *
 * 默认跳过；设置 AIDCP_E2E=1 且云端可达后运行：
 *   AIDCP_E2E=1 AIDCP_CLOUD_URL=ws://121.89.85.150:8787 npm test
 *
 * 环境层级：本地真机联调。
 *
 * 完整真机联调清单（人工执行，详见 aidcp/docs/acceptance-tests.md 第 4 节）：
 *   1. 启动 Chrome：chrome --remote-debugging-port=9222 --user-data-dir=~/.aidcp-chrome-profile
 *      --disable-blink-features=AutomationControlled
 *   2. 登录小红书（首次）
 *   3. 启动 edge 连 ECS：AIDCP_CLOUD_URL=ws://121.89.85.150:8787 npm start
 *   4. 观察自动浏览闭环（page.cards 上报 → 云端下发 {p}.note.like / {p}.{surface}.scroll）
 *   5. 发布联调：飞书点[授权发布] → 信号文件 → AIDCP_REAL_PUBLISH=true 真发一条
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { makeEnvelope, parseEnvelope, type Envelope } from '../../src/comm/protocol.js';

const E2E = process.env.AIDCP_E2E === '1';
const CLOUD_URL = process.env.AIDCP_CLOUD_URL ?? 'ws://121.89.85.150:8787';

describe('AC-E2E 真机联调（edge，gated AIDCP_E2E=1）', { skip: E2E ? false : '设 AIDCP_E2E=1 且云端可达后运行' }, () => {
  it('AC-E2E-01 边-云握手：连云端发 hello，收 welcome + sessionId', async () => {
    const ws = new WebSocket(CLOUD_URL);
    const welcome = await new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error(`握手超时：${CLOUD_URL}`)); }, 8000);
      ws.on('open', () => {
        ws.send(JSON.stringify(makeEnvelope('hello', 'e2e-hello', Date.now(), {
          edgeId: 'edge-e2e', app: 'xhs', capabilities: ['click', 'input', 'scroll'],
        })));
      });
      ws.on('message', (data) => {
        const env = parseEnvelope(String(data));
        if (env?.type === 'welcome') { clearTimeout(timer); resolve(env); }
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    assert.equal(welcome.type, 'welcome');
    assert.ok((welcome.payload as { sessionId?: string }).sessionId, '云端应分配 sessionId');
    ws.close();
  });

  it('AC-E2E-02 心跳：ping → pong', async () => {
    const ws = new WebSocket(CLOUD_URL);
    const pong = await new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('ping 超时')); }, 8000);
      ws.on('open', () => ws.send(JSON.stringify(makeEnvelope('ping', 'e2e-ping', Date.now(), {}))));
      ws.on('message', (data) => {
        const env = parseEnvelope(String(data));
        if (env?.type === 'pong') { clearTimeout(timer); resolve(env); }
      });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    assert.equal(pong.type, 'pong');
    ws.close();
  });
});
