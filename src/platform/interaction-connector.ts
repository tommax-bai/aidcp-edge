import type {
  InteractionAuthReopenPayload,
  InteractionAuthStatusPayload,
  InteractionReplyResultPayload,
  InteractionReplySendPayload,
  InteractionSyncAckPayload,
  InteractionSyncBatchPayload,
  InteractionSyncRequestPayload,
} from '../comm/protocol.js';
import type { PlatformId } from './driver.js';

/** Transport boundary keeps the connector independent from the concrete WebSocket client. */
export interface InteractionTransport {
  publishAuthStatus(payload: InteractionAuthStatusPayload): void;
  publishSyncBatch(payload: InteractionSyncBatchPayload): Promise<InteractionSyncAckPayload>;
}

/**
 * Optional platform service. XHS/Facebook are not required to implement it; a platform
 * registry either provides a connector or truthfully has no inbound-interaction runtime.
 */
export interface InteractionConnector {
  readonly platform: PlatformId;
  start(): Promise<void>;
  stop(): Promise<void>;
  getAuthStatus(): InteractionAuthStatusPayload;
  sync(request: InteractionSyncRequestPayload): Promise<void>;
  send(command: InteractionReplySendPayload): Promise<InteractionReplyResultPayload>;
  reopenAuth(request: InteractionAuthReopenPayload): Promise<void>;
  /** Late/replayed ack path; normal request-correlated acks are returned by the transport. */
  acceptSyncAck(ack: InteractionSyncAckPayload): void;
}
