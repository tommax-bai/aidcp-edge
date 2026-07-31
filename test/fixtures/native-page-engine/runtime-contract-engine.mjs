// 运行期契约用例专用的假引擎（`harden-native-engine-runtime-contracts`）。
// 与既有的 fake-engine.mjs 分开，免得两条并行流互相改对方的模式表。
//
// 模式：
//   success                  正常应答
//   commit-window-oversized  提交窗口请求带一个**超过宿主事实源上限**的预算
//   commit-window-unknown    提交窗口请求带一个宿主不认识的标签
//   exit-after-first-command 第一条命令正常应答后进程退出（模拟引擎死掉）
//   endpoint-request         第一条命令期间向宿主要一次当前端点（模拟重连），把宿主的答复原样回给用例
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const mode = process.env.AIDCP_RUNTIME_CONTRACT_ENGINE_MODE || 'success';
const pidFile = process.env.AIDCP_RUNTIME_CONTRACT_ENGINE_PID_FILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

write({
  type: 'ready',
  protocolVersion: 2,
  manifest: {
    engineVersion: 'runtime-contract-test',
    platformAdapterVersion: 'multi-platform-test',
    platformAdapters: [
      { platform: 'xiaohongshu', adapterVersion: 'xiaohongshu-test' },
      { platform: 'facebook', adapterVersion: 'facebook-test' },
      { platform: 'wechat_channels', adapterVersion: 'wechat-channels-test' },
    ],
    capabilityDigest: 'b'.repeat(64),
  },
});

const cards = {
  kind: 'page_cards',
  value: { cards: [{ index: 0, title: 'Native card', likeCount: 1, collectCount: 2 }] },
};

let pendingCommand;
let commandCount = 0;
let activeTaskId = 'runtime-contract-task';
/** 开会话时宿主交付的实例身份证据。用例据此断言这条线路没有在中途把证据丢掉。 */
let admittedBrowserDebuggerUrl = null;

const commandResult = (request, extra) => ({
  type: 'command_result',
  protocolVersion: 2,
  id: request.id,
  sessionId: request.sessionId,
  taskId: request.taskId,
  commandId: request.commandId,
  ...extra,
});

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'session_open') {
    activeTaskId = request.taskId;
    admittedBrowserDebuggerUrl = request.params?.browserDebuggerUrl ?? null;
    write({
      type: 'response',
      protocolVersion: 2,
      id: request.id,
      ok: true,
      result: {
        sessionId: request.sessionId,
        taskId: request.taskId,
        state: 'ready',
        targetId: 'target-1',
        lastCommandId: 0,
      },
    });
    return;
  }
  if (request.type === 'command') {
    commandCount += 1;
    // 提交窗口只在**第一条**命令上请求：后续命令用来验证引擎还活着。
    if (commandCount === 1 && (mode === 'commit-window-oversized' || mode === 'commit-window-unknown')) {
      pendingCommand = request;
      write({
        type: 'commit_window_request',
        protocolVersion: 2,
        id: request.id,
        sessionId: request.sessionId,
        taskId: request.taskId,
        commandId: request.commandId,
        token: `cw_${request.commandId}_1`,
        label: mode === 'commit-window-unknown' ? 'fb_unknown_commit' : 'fb_join_click',
        // 事实源上限是 18_500；引擎在这里故意多要。
        budgetMs: 90_000,
      });
      return;
    }
    // 模拟重连：引擎在命令期间向宿主要一次「这个会话现在该连哪里」。
    if (mode === 'endpoint-request') {
      pendingCommand = request;
      write({
        type: 'endpoint_request',
        protocolVersion: 2,
        id: request.id,
        sessionId: request.sessionId,
        taskId: request.taskId,
        commandId: request.commandId,
        token: `ep_${request.commandId}_1`,
      });
      return;
    }
    write(commandResult(request, {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      result: cards,
    }));
    if (mode === 'exit-after-first-command' && commandCount === 1) {
      process.stdout.write('', () => process.exit(0));
    }
    return;
  }
  if (request.type === 'commit_window_ack') {
    write({
      type: 'response',
      protocolVersion: 2,
      id: request.id,
      ok: true,
      result: { accepted: request.accepted === true },
    });
    if (!pendingCommand) return;
    const command = pendingCommand;
    pendingCommand = undefined;
    if (request.accepted === true) {
      write(commandResult(command, {
        ok: true,
        effectPhase: 'confirmed',
        reasonCode: 'confirmed',
        result: { kind: 'action_receipt', value: { action: 'join_group', ok: true, clicked: true } },
      }));
      return;
    }
    // 宿主否决了窗口：引擎在按下之前放弃，回一条诚实的未开始。
    write(commandResult(command, {
      ok: false,
      effectPhase: 'not_started',
      reasonCode: 'commit_window_unavailable',
      error: { code: 'commit_window_unavailable', message: 'host refused the commit window' },
    }));
    return;
  }
  if (request.type === 'endpoint_result') {
    write({
      type: 'response',
      protocolVersion: 2,
      id: request.id,
      ok: true,
      result: { accepted: typeof request.host === 'string' && typeof request.port === 'number' },
    });
    if (!pendingCommand) return;
    const command = pendingCommand;
    pendingCommand = undefined;
    // 把宿主的答复原样交给用例：解析到的端点 + 开会话时收到的实例身份证据。
    // 这条线路上任何一环把值丢了，用例都会当场看见。
    write(commandResult(command, {
      ok: true,
      effectPhase: 'confirmed',
      reasonCode: 'confirmed',
      result: {
        kind: 'action_receipt',
        value: {
          action: 'endpoint_echo',
          ok: true,
          reason: JSON.stringify({
            host: request.host ?? null,
            port: request.port ?? null,
            admittedBrowserDebuggerUrl,
          }),
        },
      },
    }));
    return;
  }
  if (request.type === 'session_status') {
    write({
      type: 'response',
      protocolVersion: 2,
      id: request.id,
      ok: true,
      result: {
        sessionId: request.sessionId,
        taskId: activeTaskId,
        state: 'ready',
        targetId: 'target-1',
        lastCommandId: commandCount,
      },
    });
    return;
  }
  if (request.type === 'session_close') {
    write({
      type: 'response',
      protocolVersion: 2,
      id: request.id,
      ok: true,
      result: {
        sessionId: request.sessionId,
        taskId: activeTaskId,
        state: 'closed',
        targetId: 'target-1',
        lastCommandId: commandCount,
      },
    });
    return;
  }
  if (request.type === 'shutdown') {
    process.stdout.write(`${JSON.stringify({
      type: 'response',
      protocolVersion: 2,
      id: request.id,
      ok: true,
      result: { state: 'shutting_down' },
    })}\n`, () => process.exit(0));
  }
});
