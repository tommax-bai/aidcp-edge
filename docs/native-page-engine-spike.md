# Native Page Engine read-only spike

This spike is an explicit development tool. Normal Electron/Edge startup does not build or launch it, and it is not included in normal `extraResources`.

## Build and verify the host artifact

```bash
AIDCP_CARGO_BIN=/absolute/path/to/cargo npm run build:native-page-engine
npm run verify:native-page-engine
```

The unsigned host binary and its SHA-256 record are staged under `build/native-page-engine/<platform>-<arch>/`, outside ASAR inputs. This is not a distributable signed/notarized client artifact.

## Run a read-only Xiaohongshu probe

Obtain the dynamic loopback DevTools port from the currently authorized AdsPower/self-provider environment, then run:

```bash
npm run probe:native-page-engine -- \
  --binary /absolute/path/to/aidcp-page-engine \
  --host 127.0.0.1 \
  --port <dynamic-port> \
  --timeout-ms 5000
```

The process may call only `Runtime.enable` and one constant, read-only `Runtime.evaluate` probe. It returns page classification and bounded structural counts; it does not return DOM/text/account/content/cookie/network material and cannot click, type, navigate, upload, or publish.
