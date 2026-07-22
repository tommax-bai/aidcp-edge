import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  facebookFeedVideoViewUiText,
  facebookReelViewUiText,
} from '../../src/facebook/companion-ui.js';

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

test('Feed 视频浏览叙述使用可读作者与摘要，并支持部分元数据', () => {
  assert.deepEqual(
    facebookFeedVideoViewUiText({ title: 'Hành trình đi tìm vợ con…', author: 'BHD Movies' }),
    { sentence: '看了「Hành trình đi tìm vợ con…」 · BHD Movies' },
  );
  assert.deepEqual(
    facebookFeedVideoViewUiText({ title: 'morning market' }),
    { sentence: '看了「morning market」' },
  );
  assert.deepEqual(
    facebookFeedVideoViewUiText({ author: 'BHD Movies' }),
    { sentence: '看了 BHD Movies 的一个视频' },
  );
});

test('Feed 视频浏览叙述缺少元数据时回退人话，不泄露机器标识', () => {
  const machineId = 'https://www.facebook.com/watch?v=1547652190157533';
  const machineOnlyPayload: Parameters<typeof facebookFeedVideoViewUiText>[0] & { noteId: string } = {
    noteId: machineId,
  };
  const result = facebookFeedVideoViewUiText(machineOnlyPayload);
  assert.deepEqual(result, { sentence: '看了一个视频' });
  assert.doesNotMatch(result.sentence ?? '', /1547652190157533|facebook\.com/);
});

test('Feed 视频浏览叙述按活动流宽度截断摘要与作者', () => {
  assert.deepEqual(
    facebookFeedVideoViewUiText({
      title: '1234567890123456789012345',
      author: '1234567890123456789',
    }),
    { sentence: '看了「123456789012345678901234…」 · 123456789012345678…' },
  );
});
