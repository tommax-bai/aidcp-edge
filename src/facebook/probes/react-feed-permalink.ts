export interface FacebookReactFiberLike {
  stateNode?: unknown;
  child?: FacebookReactFiberLike | null;
  sibling?: FacebookReactFiberLike | null;
  return?: FacebookReactFiberLike | null;
  memoizedProps?: unknown;
  pendingProps?: unknown;
}

/**
 * Index only the requested rendered DOM nodes while walking the current React tree.
 * The node cap keeps Facebook shape drift fail-closed instead of turning a probe into an unbounded crawl.
 */
export function indexFacebookReactFibersByStateNode(
  root: unknown,
  targets: Set<object>,
  maxNodes = 120_000,
): Map<object, FacebookReactFiberLike> {
  const indexed = new Map<object, FacebookReactFiberLike>();
  if (!root || typeof root !== 'object' || targets.size === 0 || maxNodes <= 0) return indexed;

  const stack: FacebookReactFiberLike[] = [root as FacebookReactFiberLike];
  const seen = new Set<object>();
  let visited = 0;
  while (stack.length > 0 && visited < maxNodes && indexed.size < targets.size) {
    const fiber = stack.pop();
    if (!fiber || typeof fiber !== 'object' || seen.has(fiber)) continue;
    seen.add(fiber);
    visited += 1;

    const stateNode = fiber.stateNode;
    if (stateNode && typeof stateNode === 'object' && targets.has(stateNode)) {
      indexed.set(stateNode, fiber);
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return indexed;
}

/**
 * Recover only an explicit Facebook group-post URL already present on the exact anchor's
 * React link/story chain. Opaque fragments and text are never decoded into a post identity.
 */
export function findExplicitFacebookGroupPostHrefInFiberChain(
  start: unknown,
  maxFiberDepth = 32,
): string | undefined {
  function accepted(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    try {
      const url = new URL(value, 'https://www.facebook.com/');
      const host = url.hostname.toLowerCase();
      if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return undefined;
      if (/^\/groups\/[^/]+\/(?:posts|permalink)\/[^/?#]+\/?$/i.test(url.pathname)) return url.href;
      if (
        /^\/groups\/[^/]+\/?$/i.test(url.pathname) &&
        (url.searchParams.get('multi_permalinks') ?? '').trim().length > 0
      ) {
        return url.href;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  function fromProps(root: unknown): string | undefined {
    const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
    const seen = new Set<object>();
    const preferredKeys = ['href', 'url', 'uri', 'permalink', 'link', 'story', 'timestamp', 'data', 'node'];
    let inspected = 0;
    while (queue.length > 0 && inspected < 96) {
      const current = queue.shift();
      if (!current) break;
      inspected += 1;
      const direct = accepted(current.value);
      if (direct) return direct;
      if (!current.value || typeof current.value !== 'object' || current.depth >= 4 || seen.has(current.value)) {
        continue;
      }
      seen.add(current.value);
      const record = current.value as Record<string, unknown>;
      for (const key of preferredKeys) {
        if (key in record) queue.push({ value: record[key], depth: current.depth + 1 });
      }
    }
    return undefined;
  }

  let fiber =
    start && typeof start === 'object'
      ? (start as FacebookReactFiberLike)
      : undefined;
  for (let depth = 0; fiber && depth < maxFiberDepth; depth += 1, fiber = fiber.return ?? undefined) {
    const memoized = fromProps(fiber.memoizedProps);
    if (memoized) return memoized;
    const pending = fromProps(fiber.pendingProps);
    if (pending) return pending;
  }
  return undefined;
}

/** Runtime source shared by the production CDP expression and its serialization regression test. */
export function facebookReactPermalinkRuntimeSource(): string {
  return [
    'var __name = function(target){ return target; };',
    `var indexReactFibers = (${indexFacebookReactFibersByStateNode.toString()});`,
    `var findReactGroupPostHref = (${findExplicitFacebookGroupPostHrefInFiberChain.toString()});`,
  ].join('\n');
}

/** DOM-facing helpers built on the same bounded fiber/index implementation. */
export function facebookReactDomPermalinkRuntimeSource(): string {
  return `${facebookReactPermalinkRuntimeSource()}
function fbReactRootFiber(){
  var roots=[document.documentElement,document.body].concat(
    Array.from(document.querySelectorAll('[id^="mount_"], body > div')).slice(0,120)
  );
  for(var i=0;i<roots.length;i++){
    var root=roots[i]; if(!root) continue;
    var keys=[]; try{ keys=Object.getOwnPropertyNames(root); }catch(e){ continue; }
    for(var j=0;j<keys.length;j++){
      if(keys[j].indexOf('__reactContainer$')!==0) continue;
      var container=root[keys[j]];
      if(container&&typeof container==='object') return container.current||container;
    }
  }
  return null;
}
function fbReactGroupPostHrefMap(anchors){
  var list=Array.from(anchors||[]).slice(0,600), out=new Map();
  var rootFiber=fbReactRootFiber(); if(!rootFiber||list.length===0) return out;
  var fibers=indexReactFibers(rootFiber,new Set(list),120000);
  list.forEach(function(anchor){
    var fiber=fibers.get(anchor);
    var href=fiber?findReactGroupPostHref(fiber,32):undefined;
    if(href) out.set(anchor,href);
  });
  return out;
}`;
}
