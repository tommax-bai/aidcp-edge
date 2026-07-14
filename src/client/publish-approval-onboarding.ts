/**
 * 桌面端稿件预览的客户端发起 RPC 桥：Electron main 经 core stdin 下发，
 * core 复用已建立的 EdgeClient 请求云端，再经 stdout 回传结果。
 *
 * 承载两类（change client-preview-image-delete 起）：
 * - publish.approval_action：预览内提交发布 / 取消审批
 * - publish.draft_image_remove：预览内删除某张配图
 *
 * 权限、版本校验、first-writer-wins、只删不注入与发布调度**全部在云端**完成；本模块只负责传输。
 * 二者共用同一条回执前缀 / 同一张 pending 表 / 同一个 stdin 监听器——新增回执前缀而忘了在
 * Electron 侧拦截，会让 JSON 回执当日志泄进活动流；新增 stdin 监听器则多一处缓冲区。
 */

import type { Envelope } from '../comm/protocol.js';

/** 客户端发起、按信封 id 关联应答的 publish RPC（准入白名单：不在此列的 type 一律丢弃）。 */
export type PublishClientRequestType = 'publish.approval_action' | 'publish.draft_image_remove';

const PUBLISH_CLIENT_REQUEST_TYPES: readonly PublishClientRequestType[] = [
  'publish.approval_action',
  'publish.draft_image_remove',
];

export interface PublishApprovalRequestClient {
  request<T>(type: PublishClientRequestType, payload: T, timeoutMs?: number): Promise<Envelope>;
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
    const type = message.type as PublishClientRequestType | undefined;
    if (!type || !PUBLISH_CLIENT_REQUEST_TYPES.includes(type)) return;
    if (typeof message.id !== 'string' || !message.id) return;
    void (async () => {
      try {
        const response = await client.request(type, message.payload, REQUEST_TIMEOUT_MS);
        reply({ id: message.id!, ok: true, payload: response.payload });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger(`[publish-approval] ${type} 请求失败（诚实回桥）: ${detail}`);
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
