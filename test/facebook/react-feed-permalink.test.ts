import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  facebookReactDomPermalinkRuntimeSource,
  facebookReactPermalinkRuntimeSource,
  findExplicitFacebookGroupPostHrefInFiberChain,
  indexFacebookReactFibersByStateNode,
  type FacebookReactFiberLike,
} from '../../src/facebook/probes/react-feed-permalink.js';

test('react feed permalink: indexes the exact rendered target without scanning return links', () => {
  const target = {};
  const siblingTarget = {};
  const targetFiber: FacebookReactFiberLike = { stateNode: target };
  const siblingFiber: FacebookReactFiberLike = { stateNode: siblingTarget };
  const root: FacebookReactFiberLike = { child: targetFiber };
  targetFiber.sibling = siblingFiber;

  const indexed = indexFacebookReactFibersByStateNode(root, new Set([target, siblingTarget]), 8);
  assert.equal(indexed.get(target), targetFiber);
  assert.equal(indexed.get(siblingTarget), siblingFiber);
});

test('react feed permalink: recovers an explicit canonical group-post href from the exact anchor chain', () => {
  const canonical = 'https://www.facebook.com/groups/1707108103609680/posts/1733009847686172/';
  const linkFiber: FacebookReactFiberLike = { memoizedProps: { href: canonical } };
  const baseLinkFiber: FacebookReactFiberLike = {
    memoizedProps: { href: '#?opaque' },
    return: linkFiber,
  };
  const anchorFiber: FacebookReactFiberLike = {
    memoizedProps: { href: '?__cft__[0]=opaque#?fragment' },
    return: baseLinkFiber,
  };

  assert.equal(findExplicitFacebookGroupPostHrefInFiberChain(anchorFiber), canonical);
});

test('react feed permalink: accepts explicit multi_permalinks and rejects opaque group roots or Reels', () => {
  const multi = 'https://www.facebook.com/groups/1707108103609680?multi_permalinks=1733009847686172';
  assert.equal(
    findExplicitFacebookGroupPostHrefInFiberChain({ memoizedProps: { link: { url: multi } } }),
    multi,
  );
  assert.equal(
    findExplicitFacebookGroupPostHrefInFiberChain({
      memoizedProps: { href: 'https://www.facebook.com/groups/1707108103609680#?opaque' },
    }),
    undefined,
  );
  assert.equal(
    findExplicitFacebookGroupPostHrefInFiberChain({
      memoizedProps: { href: 'https://www.facebook.com/reel/3308341169334002' },
    }),
    undefined,
  );
});

test('react feed permalink: fiber-depth bound fails closed before a later canonical link', () => {
  const canonical = 'https://www.facebook.com/groups/1/posts/2';
  const third: FacebookReactFiberLike = { memoizedProps: { href: canonical } };
  const second: FacebookReactFiberLike = { return: third };
  const first: FacebookReactFiberLike = { return: second };
  assert.equal(findExplicitFacebookGroupPostHrefInFiberChain(first, 2), undefined);
});

test('react feed permalink: serialized browser runtime executes without transpiler helper leakage', () => {
  const canonical = 'https://www.facebook.com/groups/1/posts/2';
  const expression = `(function(){
    ${facebookReactPermalinkRuntimeSource()}
    return findReactGroupPostHref({ memoizedProps: { href: ${JSON.stringify(canonical)} } });
  })()`;
  assert.equal(vm.runInNewContext(expression, { URL }), canonical);
});

test('react feed permalink: shared DOM runtime keeps the same serialized canonical resolver', () => {
  const canonical = 'https://www.facebook.com/groups/1/posts/2';
  const expression = `(function(){
    ${facebookReactDomPermalinkRuntimeSource()}
    return findReactGroupPostHref({ memoizedProps: { href: ${JSON.stringify(canonical)} } });
  })()`;
  assert.equal(vm.runInNewContext(expression, { URL, document: {} }), canonical);
});
