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
| `AIDCP_WECHAT_UNVERIFIED_WRITE_TEST_MODE` | Exact-token escape hatch injected only by an unpackaged Electron client connected to named `dev` |

Effective capability additionally requires active auth, exact identity match, a successful read/schema probe, and a closed endpoint circuit breaker. A schema mismatch opens only the affected endpoint/capability circuit.

## Probe boundary

Read probes run through the same response limits and schemas as production reads. Write probe helpers require an exact disposable-target approval token:

```text
approved-disposable-<comment|dm>-target:<external-target-id>
```

No runtime path in this module automatically submits a probe write. Setting a `*_WRITE_PROBE_VERIFIED` flag records external controlled evidence; it does not perform or claim a real send.

The unverified-write test mode is different from probe evidence. It permits only the separately labeled
first-party-bundle DM-text candidate descriptor in the unpackaged named-dev runtime. Comment create is backed
by a sanitized, platform-confirmed authorized-session capture; its bounded target snapshot stays in local Edge
runtime state and is never added to the Cloud interaction payload. Neither path bypasses
auth, identity, Cloud controls, kill switches, circuits, approval, policy, risk, quota, idempotency, or
channel-specific platform acknowledgement. Writes remain non-retry-safe and are never sent at startup.

## Validation boundary

Unit and contract tests use synthetic data only. The repository fixture retains only the structural shape of one
operator-approved, platform-confirmed comment reply; it contains no captured identifiers, profiles, credentials,
or message content. Further real-account writes still require a separately approved disposable target and scope.
