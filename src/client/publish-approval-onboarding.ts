/**
 * 桌面端稿件预览审批桥：Electron main 经 core stdin 下发审批动作，
 * core 复用已建立的 EdgeClient 请求云端，再经 stdout 回传结果。
 *
 * 审批的权限、版本校验、first-writer-wins 和发布调度全部在云端完成；本模块只负责传输。
 */

import type { Envelope } from '../comm/protocol.js';

export interface PublishApprovalRequestClient {
  request<T>(type: 'publish.approval_action', payload: T, timeoutMs?: number): Promise<Envelope>;
}

export interface PublishApprovalReply {
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

export function makePublishApprovalStdinHandler(
  client: PublishApprovalRequestClient,
  reply: (value: PublishApprovalReply) => void,
  logger: (message: string) => void = console.log,
): (chunk: string) => void {
  let buffer = '';

  function handleLine(line: string): void {
    let message: { type?: string; id?: string; payload?: unknown };
    try {
      message = JSON.parse(line) as { type?: string; id?: string; payload?: unknown };
    } catch {
      return;
    }
    if (message.type !== 'publish.approval_action' || typeof message.id !== 'string' || !message.id) return;
    void (async () => {
      try {
        const response = await client.request('publish.approval_action', message.payload, REQUEST_TIMEOUT_MS);
        reply({ id: message.id!, ok: true, payload: response.payload });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger(`[publish-approval] 请求失败（诚实回桥）: ${detail}`);
        reply({ id: message.id!, ok: false, error: detail });
      }
    })();
  }

  return (chunk: string): void => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      newline = buffer.indexOf('\n');
    }
  };
}

export function registerPublishApprovalStdinCommands(
  client: PublishApprovalRequestClient,
  logger: (message: string) => void = console.log,
): void {
  const onChunk = makePublishApprovalStdinHandler(
    client,
    (value) => process.stdout.write(`[publish-approval-reply] ${JSON.stringify(value)}\n`),
    logger,
  );
  process.stdin.on('data', (chunk: Buffer) => onChunk(chunk.toString('utf8')));
}
