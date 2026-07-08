/**
 * 建号自助人设 · core 侧 stdin/stdout 桥（change edge-persona-keyword-generation）。
 *
 * 数据流：桌面壳（Electron main）经 core 子进程 stdin 下发 `{type:'persona.generate'|'persona.persist', id, payload}`
 * →本模块调 `client.request()` 打到云端（WS 只在 core 子进程里）→结果经 stdout 结构化行
 * `[persona-reply] {id, ...}` 回桥，桌面壳按 id 命中 pending resolve。
 *
 * 与 browser-parking 的 readline stdin 控制**并存**：本模块用原始 `process.stdin.on('data')` 监听、按 type
 * 过滤，只处理 persona.*；browser-parking 的 readline 只处理 browser.*，两者互不干扰（各自忽略对方消息）。
 * 故**不改动** browser-parking 那条已上线路径。
 *
 * 红线：大模型/密钥/校验/落库全在云端；本模块只透传 stdin 请求→WS→stdout 回执，不本地判成功、不兜底。
 */

import type { Envelope } from '../comm/protocol.js';

/** 显式长超时：≥185s，覆盖云端 180s 模型天花板（request 默认仅 15s，必须覆盖，否则误报生成失败）。 */
export const PERSONA_REQUEST_TIMEOUT_MS = 190_000;

/** core 侧只需要 request 能力（发请求等按 id 回包的响应信封）。 */
export interface PersonaRequestClient {
  request<T>(type: 'persona.generate' | 'persona.persist', payload: T, timeoutMs?: number): Promise<Envelope>;
}

/** 回执出口（生产=写 stdout `[persona-reply]` 行；测试可注入捕获）。 */
export type PersonaReplyFn = (obj: { id: string; ok: boolean; payload?: unknown; error?: string }) => void;

/**
 * 造一个「按行喂 stdin 文本」的处理器（纯函数式、可单测）：内部按 `\n` 缓冲分行，
 * 只处理 persona.generate / persona.persist，调 client.request 后经 reply 回执。返回喂 chunk 的函数。
 */
export function makePersonaStdinHandler(
  client: PersonaRequestClient,
  reply: PersonaReplyFn,
  logger: (message: string) => void = console.log,
): (chunk: string) => void {
  let buffer = '';

  function handleLine(line: string): void {
    let msg: { type?: string; id?: string; payload?: unknown };
    try {
      msg = JSON.parse(line) as { type?: string; id?: string; payload?: unknown };
    } catch {
      return; // 非 JSON / 非本模块行（含 browser.* 由 readline 处理）— 忽略
    }
    if (msg.type !== 'persona.generate' && msg.type !== 'persona.persist') return;
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (!id) return;
    void dispatch(msg.type, id, msg.payload);
  }

  async function dispatch(
    type: 'persona.generate' | 'persona.persist',
    id: string,
    payload: unknown,
  ): Promise<void> {
    try {
      const res = await client.request(type, payload, PERSONA_REQUEST_TIMEOUT_MS);
      reply({ id, ok: true, payload: res.payload });
    } catch (err) {
      logger(`[persona] ${type} 请求失败（诚实回桥，不本地兜底）: ${(err as Error).message}`);
      reply({ id, ok: false, error: (err as Error).message });
    }
  }

  return (chunk: string): void => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
  };
}

/**
 * 装上 persona stdin 命令桥。须在 EdgeClient 创建后调用（身份已确立、client 可 request）。
 * 与桌面壳 stdin 桥同一开关 AIDCP_BROWSER_CONTROL_STDIN；未开则不装（非 Electron / 测试环境安全空转）。
 */
export function registerPersonaStdinCommands(
  client: PersonaRequestClient,
  logger: (message: string) => void = console.log,
): void {
  if (process.env.AIDCP_BROWSER_CONTROL_STDIN !== '1') return;
  const onChunk = makePersonaStdinHandler(
    client,
    (obj) => process.stdout.write(`[persona-reply] ${JSON.stringify(obj)}\n`),
    logger,
  );
  process.stdin.on('data', (chunk: Buffer) => onChunk(chunk.toString('utf8')));
}
