/**
 * Build-time edge capabilities (change captcha-assist-text-answer).
 *
 * These are capabilities the running BINARY has, independent of which platform driver it drives.
 * They MUST be merged into the hello `capabilities` inside the `EdgeClient` constructor — NOT into
 * any driver's static `edgeCapabilities` constant. Rationale (design D8):
 *   - A build capability ≠ a platform capability. Putting it in a driver constant is a category error.
 *   - There are two assembly paths (main.ts + wechat-channels/runtime.ts) and three drivers; miss one
 *     driver and that platform is permanently 409 for text assist, indistinguishable from «old client».
 *   - Merging in the constructor means every assembly path and every future platform gets it for free.
 *
 * Cloud fail-closes on the presence of `captcha_assist_text_v1`: an edge that does not advertise it
 * (an old binary that would silently ignore the `text` field and only click) is rejected with 409
 * `edge_lacks_text_capability` before any command is dispatched.
 */
import {
  CLIENT_CORE_BROWSER_EXECUTOR_CAPABILITY,
  CLIENT_DATA_PLANE_AUTOMATION_ENGINE_CAPABILITY,
  SEARCH_ACTIVITY_RECEIPT_CAPABILITY,
} from '../comm/protocol.js';

export const EDGE_BUILD_CAPABILITIES = [
  'captcha_assist_text_v1',
  CLIENT_CORE_BROWSER_EXECUTOR_CAPABILITY,
  CLIENT_DATA_PLANE_AUTOMATION_ENGINE_CAPABILITY,
  SEARCH_ACTIVITY_RECEIPT_CAPABILITY,
] as const;
