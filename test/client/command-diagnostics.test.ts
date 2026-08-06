import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_DIAGNOSTIC_PREFIX,
  commandDiagnosticLine,
  isActiveCommandType,
  summarizeCommand,
} from '../../src/client/command-diagnostics.js';

test('command diagnostics: active command families produce useful whitelist-only summaries', () => {
  const cases: Array<{ type: string; payload: Record<string, unknown>; expected: RegExp }> = [
    { type: 'plan.response', payload: { steps: [{ secret: 'step-secret' }], reason: 'reason-secret' }, expected: /1 个顺序步骤/ },
    { type: 'facebook.note.open', payload: { surface: 'detail', purpose: 'read', url: 'https://secret.test/x?token=1', noteId: 'note-secret' }, expected: /已提供目标地址/ },
    { type: 'xiaohongshu.search.execute', payload: { keyword: '绝密词', source: 'manager', maxResults: 8 }, expected: /搜索词 3 字/ },
    { type: 'interaction.comment', payload: { text: '不要展示这条评论', groupChatCode: 'chat-secret' }, expected: /评论正文 8 字/ },
    { type: 'facebook.group.join', payload: { click: true, groupUrl: 'https://secret.test/group' }, expected: /申请加入目标群组/ },
    { type: 'publish.command', payload: { kind: 'fill_field', seq: 2, recordId: 9988, taskId: 'task-secret', params: { value: 'body-secret' } }, expected: /发布步骤 fill_field，序号 2/ },
    { type: 'edge.task.acquire', payload: { kind: 'publish', priority: 'human', taskId: 'task-secret' }, expected: /任务 publish，优先级 human/ },
    { type: 'captcha.assist.click', payload: { points: [{ x: 0.2, y: 0.3 }], text: '答案秘密', snapshotId: 'snapshot-secret', submit: 'enter' }, expected: /1 个点击点，输入 4 字，包含回车提交/ },
    { type: 'interaction.reply.send', payload: { channel: 'dm', content: { type: 'text', text: '私信秘密' }, accountId: 'account-secret' }, expected: /渠道 dm，回复正文 4 字/ },
  ];

  for (const item of cases) {
    assert.equal(isActiveCommandType(item.type), true, item.type);
    assert.match(summarizeCommand(item.type, item.payload), item.expected, item.type);
  }
});

test('command diagnostics: event contains neither raw payload, envelope id, nor newly added unknown fields', () => {
  const secrets = [
    'raw-envelope-secret',
    'keyword-secret',
    'cookie-secret',
    'token-secret',
    'https://secret.test/path?token=secret',
    'future-secret-field',
  ];
  const line = commandDiagnosticLine({
    id: secrets[0],
    type: 'xiaohongshu.search.execute',
    payload: {
      keyword: secrets[1],
      cookie: secrets[2],
      token: secrets[3],
      container: secrets[4],
      futureField: secrets[5],
    },
  }, 'received');

  assert.ok(line.startsWith(`${COMMAND_DIAGNOSTIC_PREFIX} `));
  for (const secret of secrets) assert.equal(line.includes(secret), false, secret);
  const event = JSON.parse(line.slice(COMMAND_DIAGNOSTIC_PREFIX.length + 1)) as Record<string, unknown>;
  assert.match(String(event.key), /^[a-f0-9]{8}$/);
  assert.deepEqual(Object.keys(event).sort(), ['key', 'stage', 'summary', 'type']);
});

test('command diagnostics: malformed enums and unknown command payload fall back without reflection', () => {
  const summary = summarizeCommand('future.command', {
    kind: 'secret-kind',
    text: 'secret-text',
    url: 'https://secret.test',
  });
  assert.equal(summary, '载荷内容未展示');
  assert.equal(summary.includes('secret'), false);

  const malformed = summarizeCommand('publish.command', { kind: 'secret-kind', seq: -20, params: { value: 'secret' } });
  assert.equal(malformed, '发布原子步骤，序号 0');
  assert.equal(malformed.includes('secret'), false);
});

test('command diagnostics: Reels entry reasons are named without changing ordinary page scrolls', () => {
  // 词汇批 4：面由命令名声明；Reels/恢复摘要按类型直判，不再读 targetSurface 载荷字段。
  assert.equal(
    summarizeCommand('facebook.reels.scroll', { reason: 'resume_redrive' }),
    '恢复 Reels 浏览',
  );
  assert.equal(
    summarizeCommand('facebook.feed.scroll', { reason: 'resume_redrive' }),
    '恢复信息流浏览',
  );
  assert.equal(
    summarizeCommand('xiaohongshu.feed.scroll', { reason: 'resume_redrive' }),
    '恢复信息流浏览',
  );
  assert.equal(
    summarizeCommand('facebook.reels.scroll', { reason: 'facebook_reels_primary' }),
    '进入 Reels 主浏览',
  );
  assert.equal(
    summarizeCommand('facebook.reels.scroll', { reason: 'empty_feed_reels_fallback' }),
    '信息流结束，进入 Reels',
  );
  assert.equal(summarizeCommand('facebook.feed.scroll', { reason: 'feed_scroll' }), '滚动当前信息流');
  assert.equal(summarizeCommand('xiaohongshu.search.scroll', {}), '滚动搜索结果页');
  assert.equal(
    summarizeCommand('facebook.reels.scroll', { reason: 'facebook_reels_primary', url: 'https://secret.test/reels' })
      .includes('secret'),
    false,
  );
});
