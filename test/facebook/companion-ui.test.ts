import { test } from 'node:test';
import assert from 'node:assert/strict';
import { facebookReelViewUiText } from '../../src/facebook/companion-ui.js';

test('Reel 浏览叙述只表达看过当前卡片，并使用可读作者与摘要', () => {
  assert.deepEqual(
    facebookReelViewUiText({ title: 'first reel summary', author: 'Bao' }),
    { sentence: '看了「first reel summary」 · Bao' },
  );
});

test('Reel 浏览叙述缺少元数据时回退人话，不泄露机器标识', () => {
  assert.deepEqual(facebookReelViewUiText({}), { sentence: '看了一个 Reel' });
  assert.deepEqual(
    facebookReelViewUiText({ author: 'Salon de Comolis' }),
    { sentence: '看了 Salon de Comolis 的一个 Reel' },
  );
});

test('Reel 浏览叙述按活动流宽度截断摘要与作者', () => {
  assert.deepEqual(
    facebookReelViewUiText({
      title: '1234567890123456789012345',
      author: '1234567890123456789',
    }),
    { sentence: '看了「123456789012345678901234…」 · 123456789012345678…' },
  );
});
