# WeChat Channels interaction adapter

This module implements the Edge half of the frozen `wechat-channels-interaction-management` v1 contract. The creator-assistant endpoints are private, undocumented platform behavior; they are isolated behind `WechatChannelsApiClient` and must not be represented as an official or stable SDK.

## Runtime scope

- Exact platform ID: `wechat_channels`.
- Required identity inputs: `AIDCP_ENV_KEY` (or `AIDCP_ADS_USER_ID`), `AIDCP_WECHAT_ACCOUNT_ID` (or `AIDCP_ACCOUNT_ID`), and an AdsPower/browser profile ID.
- Session material stays on Edge in AES-256-GCM encrypted storage. Its binding includes environment, account, Finder identity, and browser profile.
- The browser is an authentication sidecar. After identity verification, encrypted persistence, and enabled read probes succeed, it closes while the Edge WebSocket and connector timers remain online.
- `interaction.dm.send_image` is always false in v1.

## Feature flags

All private capabilities and writes default off.

| Variable | Purpose |
| --- | --- |
| `AIDCP_WECHAT_INTERACTION_ENABLED` | Global adapter gate |
| `AIDCP_WECHAT_ACCOUNT_KILL_SWITCH` | Account-level read/write kill switch |
| `AIDCP_WECHAT_COMMENTS_READ_ENABLED` | Comment read endpoint gate |
| `AIDCP_WECHAT_DM_READ_ENABLED` | DM read endpoint gate |
| `AIDCP_WECHAT_WRITE_ENABLED` | Global write gate |
| `AIDCP_WECHAT_ACCOUNT_WRITE_ENABLED` | Account write allowlist gate |
| `AIDCP_WECHAT_ACCOUNT_WRITE_KILL_SWITCH` | Account write-only kill switch |
| `AIDCP_WECHAT_COMMENTS_REPLY_ENABLED` | Comment text reply endpoint gate |
| `AIDCP_WECHAT_DM_SEND_TEXT_ENABLED` | DM text endpoint gate |
| `AIDCP_WECHAT_COMMENT_WRITE_PROBE_VERIFIED` | Operator-recorded controlled comment probe evidence |
| `AIDCP_WECHAT_DM_WRITE_PROBE_VERIFIED` | Operator-recorded controlled DM probe evidence |

Effective capability additionally requires active auth, exact identity match, a successful read/schema probe, and a closed endpoint circuit breaker. A schema mismatch opens only the affected endpoint/capability circuit.

## Probe boundary

Read probes run through the same response limits and schemas as production reads. Write probe helpers require an exact disposable-target approval token:

```text
approved-disposable-<comment|dm>-target:<external-target-id>
```

No runtime path in this module automatically submits a probe write. Setting a `*_WRITE_PROBE_VERIFIED` flag records external controlled evidence; it does not perform or claim a real send.

## Validation boundary

Unit and contract tests use synthetic data only. Real-account reads, browser cold-stop operation, endpoint field stability, and approved disposable-target writes remain integration gates until a test account owner supplies the required scope.
