import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseFacebookCount } from '../../src/facebook/feed-reader.js';
import {
  classifyFacebookSurface,
  normalizeFacebookPermalinks,
} from '../../src/facebook/probes/page-structure.js';
import { parseNativeWechatSessionCandidate } from '../../src/wechat-channels/browser-sidecar.js';

interface Fixture {
  facebook: {
    counts: Array<{ input: string; expected: number }>;
    surfaces: Array<{ input: string; expected: string }>;
    permalinks: {
      inputs: string[];
      expected: Array<{ href: string; kind: string }>;
    };
  };
  wechat: {
    candidate: unknown;
  };
}

const fixture = JSON.parse(
  await readFile(
    new URL('../fixtures/native-page-engine/platform-cutover-characterization.json', import.meta.url),
    'utf8',
  ),
) as Fixture;

test('platform cutover characterization: Facebook semantic normalization remains stable', () => {
  assert.deepEqual(
    fixture.facebook.counts.map(({ input }) => parseFacebookCount(input)),
    fixture.facebook.counts.map(({ expected }) => expected),
  );
  assert.deepEqual(
    fixture.facebook.surfaces.map(({ input }) => classifyFacebookSurface(input)),
    fixture.facebook.surfaces.map(({ expected }) => expected),
  );
  assert.deepEqual(
    normalizeFacebookPermalinks(fixture.facebook.permalinks.inputs),
    fixture.facebook.permalinks.expected,
  );
});

test('platform cutover characterization: WeChat session-capture result remains bounded and stable', () => {
  assert.deepEqual(parseNativeWechatSessionCandidate(fixture.wechat.candidate), fixture.wechat.candidate);
});
