import type { WechatChannelsApiClient } from '../api-client.js';
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

export class WechatChannelsProbeRunner {
  private readonly results: ProbeResult[] = [];

  constructor(private readonly options: ProbeRunnerOptions) {}

  snapshot(): ProbeResult[] {
    return this.results.map((result) => ({ ...result }));
  }

  async probeEnabledReads(session: WechatSessionMaterial): Promise<boolean> {
    const commentsEnabled = this.options.flags.interactionEnabled && this.options.flags.commentsReadEnabled;
    const dmEnabled = this.options.flags.interactionEnabled && this.options.flags.dmReadEnabled;
    if (!commentsEnabled && !dmEnabled) return true;
    let passed = false;
    if (commentsEnabled) passed = (await this.probeComments(session)) || passed;
    else this.record({ capability: 'commentsRead', mode: 'read_only', status: 'disabled', endpoint: 'postList', reasonCode: null });
    if (dmEnabled) passed = (await this.probeDm(session)) || passed;
    else this.record({ capability: 'dmRead', mode: 'read_only', status: 'disabled', endpoint: 'dmNewMessages', reasonCode: null });
    return passed;
  }

  private async probeComments(session: WechatSessionMaterial): Promise<boolean> {
    try {
      const posts = await this.options.api.listPosts(session, null, 1);
      const postId = this.options.commentProbePostId ?? posts.items[0]?.externalId;
      if (!postId) {
        this.record({ capability: 'commentsRead', mode: 'read_only', status: 'gated', endpoint: 'commentList', reasonCode: 'NO_READ_PROBE_SCOPE' });
        return false;
      }
      await this.options.api.listComments(session, postId, null, 1);
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
      return true;
    } catch (error) {
      this.options.capabilityState.clearProbe('commentsRead');
      this.options.capabilityState.clearProbe('commentsReply');
      this.record({ capability: 'commentsRead', mode: 'read_only', status: 'failed', endpoint: 'postList+commentList', reasonCode: safeReason(error) });
      return false;
    }
  }

  private async probeDm(session: WechatSessionMaterial): Promise<boolean> {
    try {
      const sessions = await this.options.api.listDmSessions(session, null, 1);
      const threadId = this.options.dmProbeThreadId ?? sessions.items[0]?.externalId;
      if (!threadId) {
        this.record({ capability: 'dmRead', mode: 'read_only', status: 'gated', endpoint: 'dmHistory', reasonCode: 'NO_READ_PROBE_SCOPE' });
        return false;
      }
      await this.options.api.listDmHistory(session, threadId, null, 1);
      this.options.capabilityState.markProbePassed('dmRead');
      if (this.options.flags.dmWriteProbeVerified) this.options.capabilityState.markProbePassed('dmSendText');
      this.record({ capability: 'dmRead', mode: 'read_only', status: 'passed', endpoint: 'dmNewMessages+dmHistory', reasonCode: null });
      this.record({
        capability: 'dmSendText',
        mode: 'gated_write',
        status: this.options.flags.dmWriteProbeVerified ? 'passed' : 'gated',
        endpoint: 'dmSendText',
        reasonCode: this.options.flags.dmWriteProbeVerified ? null : 'WRITE_PROBE_NOT_APPROVED',
      });
      return true;
    } catch (error) {
      this.options.capabilityState.clearProbe('dmRead');
      this.options.capabilityState.clearProbe('dmSendText');
      this.record({ capability: 'dmRead', mode: 'read_only', status: 'failed', endpoint: 'dmNewMessages+dmHistory', reasonCode: safeReason(error) });
      return false;
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

function safeReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'INTERACTION_UPSTREAM_UNAVAILABLE';
}
