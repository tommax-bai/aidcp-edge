/**
 * CDP target 发现：通过 DevTools HTTP 端点（默认 http://127.0.0.1:9222/json）
 * 列出可调试的 page，拿到 webSocketDebuggerUrl 交给 CdpClient。
 *
 * 启动 Chrome 示例：
 *   chrome --remote-debugging-port=9222 --user-data-dir=/tmp/aidcp-profile
 */

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface DiscoverOptions {
  /** DevTools host，默认 127.0.0.1 */
  host?: string;
  /** DevTools 端口，默认 9222 */
  port?: number;
  /** 注入 fetch（测试用），默认全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 列出所有可调试 target */
export async function listTargets(options: DiscoverOptions = {}): Promise<CdpTarget[]> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 9222;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (!doFetch) throw new Error('global fetch 不可用（需 Node>=18）；请注入 fetchImpl');
  const res = await doFetch(`http://${host}:${port}/json`);
  if (!res.ok) {
    throw new Error(`DevTools /json 请求失败: HTTP ${res.status}`);
  }
  const data = (await res.json()) as CdpTarget[];
  return data;
}

/** 选取第一个 type==='page' 的 target（可按 url 过滤） */
export async function firstPageTarget(
  options: DiscoverOptions & { urlIncludes?: string; targetPredicate?: (target: CdpTarget) => boolean } = {},
): Promise<CdpTarget> {
  const targets = await listTargets(options);
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const match = options.targetPredicate
    ? pages.find(options.targetPredicate)
    : options.urlIncludes
      ? pages.find((t) => t.url.includes(options.urlIncludes!))
      : pages[0];
  if (!match) {
    throw new Error('未找到可用的 page target（确认 Chrome 已用 --remote-debugging-port 启动）');
  }
  return match;
}
