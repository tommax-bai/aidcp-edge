# WeChat Channels interaction adapter

This module implements the Edge half of the frozen `wechat-channels-interaction-management` v1 contract. The creator-assistant endpoints are private, undocumented platform behavior; they are isolated behind `WechatChannelsApiClient` and must not be represented as an official or stable SDK.

## Runtime scope

- Exact platform ID: `wechat_channels`.
- Required identity inputs: `AIDCP_ENV_KEY` (or `AIDCP_ADS_USER_ID`), `AIDCP_WECHAT_ACCOUNT_ID` (or `AIDCP_ACCOUNT_ID`), and an AdsPower/browser profile ID.
- Session material stays on Edge in AES-256-GCM encrypted storage. Its binding includes environment, account, Finder identity, and browser profile.
- The browser is an authentication sidecar. After identity verification, encrypted persistence, and enabled read probes succeed, it closes while the Edge WebSocket and connector timers remain online.
- `interaction.dm.send_image` is always false in v1.

## Product controls

Account and channel authorization comes only from the scoped, versioned Cloud runtime-controls snapshot. Effective capability additionally requires active auth, exact identity match, a successful corresponding read/schema probe, and a closed endpoint circuit breaker. A schema mismatch opens only the affected endpoint/capability circuit. Stale `AIDCP_WECHAT_*` product-gate environment variables are ignored and stripped from Electron child environments.

## Probe boundary

Read probes run through the same response limits and schemas as production reads. Write probe helpers require an exact disposable-target approval token:

```text
approved-disposable-<comment|dm>-target:<external-target-id>
```

No runtime path in this module automatically submits a probe write. Production sends are authorized by Cloud controls and still require exact-target validation, idempotency, single-flight and post-action confirmation.

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
