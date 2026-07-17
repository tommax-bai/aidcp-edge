import type { InteractionAuthReasonCode } from '../../comm/protocol.js';
import type { WechatChannelsApiClient } from '../api-client.js';
import { WechatChannelsError } from '../error-classifier.js';
import type { WechatChannelsFeatureFlags, WechatCapabilityState } from '../feature-flags.js';
import type { WechatSessionMaterial } from '../types.js';

export type ProbeEvidenceMode = 'mock' | 'read_only' | 'gated_write';

export interface ProbeResult {
  capability: 'commentsRead' | 'commentsReply' | 'dmRead' | 'dmSendText';
  mode: ProbeEvidenceMode;
  status: 'passed' | 'failed' | 'gated' | 'disabled';
  endpoint: string;
  reasonCode: string | null;
}

export interface ProbeRunnerOptions {
  api: WechatChannelsApiClient;
  flags: WechatChannelsFeatureFlags;
  capabilityState: WechatCapabilityState;
  commentProbePostId?: string;
  dmProbeThreadId?: string;
}

export type WechatProbeOutcome =
  | { ok: true }
  | { ok: false; reasonCode: InteractionAuthReasonCode };

export class WechatChannelsProbeRunner {
  private readonly results: ProbeResult[] = [];

  constructor(private readonly options: ProbeRunnerOptions) {}

  snapshot(): ProbeResult[] {
    return this.results.map((result) => ({ ...result }));
  }

  async probeEnabledReads(session: WechatSessionMaterial): Promise<WechatProbeOutcome> {
    const remote = this.options.capabilityState.getRemoteControls();
    const commentsEnabled = this.options.flags.interactionEnabled && remote?.commentsReadEnabled === true;
    const dmEnabled = this.options.flags.interactionEnabled && remote?.dmReadEnabled === true;
    if (!commentsEnabled && !dmEnabled) return { ok: true };
    let passed = false;
    let failureReason: InteractionAuthReasonCode | null = null;
    if (commentsEnabled) {
      const outcome = await this.probeComments(session);
      passed = outcome.ok || passed;
      if (!outcome.ok) failureReason ??= outcome.reasonCode;
    }
    else this.record({ capability: 'commentsRead', mode: 'read_only', status: 'disabled', endpoint: 'postList', reasonCode: null });
    if (dmEnabled) {
      const outcome = await this.probeDm(session);
      passed = outcome.ok || passed;
      if (!outcome.ok) failureReason ??= outcome.reasonCode;
    }
    else this.record({ capability: 'dmRead', mode: 'read_only', status: 'disabled', endpoint: 'dmNewMessages', reasonCode: null });
    return passed ? { ok: true } : { ok: false, reasonCode: failureReason ?? 'INTERACTION_UPSTREAM_UNAVAILABLE' };
  }

  private async probeComments(session: WechatSessionMaterial): Promise<WechatProbeOutcome> {
    try {
      const posts = await this.options.api.listPosts(session, null, 1);
      this.options.capabilityState.breaker.close('postList');
      const postId = this.options.commentProbePostId ?? posts.items[0]?.externalId;
      if (!postId) {
        this.record({ capability: 'commentsRead', mode: 'read_only', status: 'gated', endpoint: 'commentList', reasonCode: 'NO_READ_PROBE_SCOPE' });
        return { ok: true };
      }
      await this.options.api.listComments(session, postId, null, 1);
      this.options.capabilityState.breaker.close('commentList');
      this.options.capabilityState.markProbePassed('commentsRead');
      if (this.options.flags.commentWriteProbeVerified) this.options.capabilityState.markProbePassed('commentsReply');
      this.record({ capability: 'commentsRead', mode: 'read_only', status: 'passed', endpoint: 'postList+commentList', reasonCode: null });
      this.record({
        capability: 'commentsReply',
        mode: 'gated_write',
        status: this.options.flags.commentWriteProbeVerified ? 'passed' : 'gated',
        endpoint: 'commentCreate',
        reasonCode: this.options.flags.commentWriteProbeVerified ? null : 'WRITE_PROBE_NOT_APPROVED',
      });
      return { ok: true };
    } catch (error) {
      this.options.capabilityState.clearProbe('commentsRead');
      this.options.capabilityState.clearProbe('commentsReply');
      const reasonCode = safeReason(error);
      this.record({ capability: 'commentsRead', mode: 'read_only', status: 'failed', endpoint: 'postList+commentList', reasonCode });
      return { ok: false, reasonCode };
    }
  }

  private async probeDm(session: WechatSessionMaterial): Promise<WechatProbeOutcome> {
    try {
      const sessions = await this.options.api.listDmSessions(session, null, 1);
      this.options.capabilityState.breaker.close('dmHistory');
      if (!(this.options.dmProbeThreadId ?? sessions.items[0]?.externalId)) {
        this.options.capabilityState.markProbePassed('dmRead');
        this.record({ capability: 'dmRead', mode: 'read_only', status: 'passed', endpoint: 'dmHistory', reasonCode: null });
        return { ok: true };
      }
      this.options.capabilityState.markProbePassed('dmRead');
      if (this.options.flags.dmWriteProbeVerified) this.options.capabilityState.markProbePassed('dmSendText');
      this.record({ capability: 'dmRead', mode: 'read_only', status: 'passed', endpoint: 'dmHistory', reasonCode: null });
      this.record({
        capability: 'dmSendText',
        mode: 'gated_write',
        status: this.options.flags.dmWriteProbeVerified ? 'passed' : 'gated',
        endpoint: 'dmSendText',
        reasonCode: this.options.flags.dmWriteProbeVerified ? null : 'WRITE_PROBE_NOT_APPROVED',
      });
      return { ok: true };
    } catch (error) {
      this.options.capabilityState.clearProbe('dmRead');
      this.options.capabilityState.clearProbe('dmSendText');
      const reasonCode = safeReason(error);
      this.record({ capability: 'dmRead', mode: 'read_only', status: 'failed', endpoint: 'dmHistory', reasonCode });
      return { ok: false, reasonCode };
    }
  }

  private record(result: ProbeResult): void {
    this.results.push(result);
  }
}

export interface WriteProbeGateInput {
  approval: string | undefined;
  targetExternalId: string | undefined;
  channel: 'comment' | 'dm';
}

/** No write callback is reachable unless the operator names the exact disposable target in the approval token. */
export function assertWriteProbeGate(input: WriteProbeGateInput): { targetExternalId: string } {
  const targetExternalId = input.targetExternalId?.trim();
  const expected = targetExternalId ? `approved-disposable-${input.channel}-target:${targetExternalId}` : '';
  if (!targetExternalId || input.approval !== expected) {
    throw new Error('WRITE_PROBE_GATED: exact disposable target approval is required');
  }
  return { targetExternalId };
}

function safeReason(error: unknown): InteractionAuthReasonCode {
  if (!(error instanceof WechatChannelsError)) return 'INTERACTION_UPSTREAM_UNAVAILABLE';
  switch (error.category) {
    case 'rate_limited': return 'WECHAT_RATE_LIMITED';
    case 'transient_network': return 'INTERACTION_UPSTREAM_UNAVAILABLE';
    case 'permission_denied': return 'WECHAT_PERMISSION_DENIED';
    case 'schema_changed': return 'WECHAT_SCHEMA_CHANGED';
    case 'auth_expired': return 'WECHAT_AUTH_REQUIRED';
    case 'challenge_required': return 'WECHAT_CHALLENGE_REQUIRED';
    case 'identity_mismatch': return 'WECHAT_IDENTITY_MISMATCH';
    default: return 'INTERACTION_UPSTREAM_UNAVAILABLE';
  }
}
