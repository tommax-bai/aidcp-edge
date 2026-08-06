import type { Envelope, GroupJoinPayload } from '../comm/protocol.js';
import type { ActionCompletedPayload } from '../comm/protocol.js';
import type { FacebookJoinExecutor } from './join-executor.js';

export interface FacebookJoinReplyClient {
  reportActionCompleted(payload: ActionCompletedPayload): void;
}

export interface FacebookJoinHandlerDeps {
  executor: FacebookJoinExecutor;
  client: FacebookJoinReplyClient;
  logger?: (msg: string) => void;
}

export class FacebookJoinHandler {
  private readonly executor: FacebookJoinExecutor;
  private readonly client: FacebookJoinReplyClient;
  private readonly log: (msg: string) => void;
  private busy = false;

  constructor(deps: FacebookJoinHandlerDeps) {
    this.executor = deps.executor;
    this.client = deps.client;
    this.log = deps.logger ?? (() => {});
  }

  async handle(env: Envelope): Promise<void> {
    if (env.type !== 'facebook.group.join') {
      this.client.reportActionCompleted({ action: env.type, ok: false, reason: 'capability_unsupported' });
      return;
    }
    if (this.busy) {
      this.client.reportActionCompleted({ action: 'join_group', ok: false, reason: 'busy' });
      return;
    }
    this.busy = true;
    try {
      const payload = env.payload as GroupJoinPayload;
      const r = await this.executor.joinGroup(payload.groupUrl, { click: payload.click, thinkMs: payload.thinkMs });
      this.client.reportActionCompleted({
        action: 'join_group',
        ok: r.ok,
        groupUrl: r.groupUrl,
        clicked: r.clicked,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.observation ? { observation: r.observation } : {}),
        ...(r.postObservation ? { postObservation: r.postObservation } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[fb-join] handler failed: ${message}`);
      this.client.reportActionCompleted({ action: 'join_group', ok: false, reason: `handler_error:${message}` });
    } finally {
      this.busy = false;
    }
  }
}
