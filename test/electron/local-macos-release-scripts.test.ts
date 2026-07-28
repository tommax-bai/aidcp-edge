import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const common = readFileSync(
  join(root, 'scripts/build-desktop-macos-ol-arm64-common.sh'),
  'utf8',
);
const signed = readFileSync(
  join(root, 'scripts/build-desktop-macos-ol-arm64-signed.sh'),
  'utf8',
);
const notarized = readFileSync(
  join(root, 'scripts/build-desktop-macos-ol-arm64-notarized.sh'),
  'utf8',
);

test('local macOS release entrypoints select the shared release implementation', () => {
  assert.match(signed, /build-desktop-macos-ol-arm64-common\.sh" signed-only/);
  assert.match(notarized, /build-desktop-macos-ol-arm64-common\.sh" notarized/);
  assert.doesNotMatch(signed, /notarytool|stapler|APPLE_API_/);
  assert.doesNotMatch(notarized, /notarytool|stapler|APPLE_API_/);
});

test('shared release implementation builds every packaged runtime for arm64', () => {
  assert.match(common, /npm ci --prefer-offline/);
  assert.match(common, /npm run verify:desktop-build-input/);
  assert.match(common, /npm run build:dist/);
  assert.match(common, /npm run build:ads-runtime/);
  assert.match(common, /npm run build:gost -- arm64/);
  assert.match(common, /npm run build:native-page-engines-for-package -- arm64/);
  assert.match(common, /rust-version/);
  assert.match(common, /RUSTUP_TOOLCHAIN="\$rust_version"/);
  assert.match(common, /target add --toolchain "\$rust_version" aarch64-apple-darwin/);
});

test('shared release implementation keeps credentials external and supports keychain signing', () => {
  assert.match(common, /CSC_NAME/);
  assert.match(common, /CSC_LINK/);
  assert.match(common, /CSC_KEY_PASSWORD/);
  assert.match(common, /read -r -s CSC_KEY_PASSWORD <\/dev\/tty/);
  assert.match(common, /APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER/);
  assert.doesNotMatch(common, /AuthKey_[A-Z0-9]+\.p8/);
  assert.doesNotMatch(common, /Documents\/.*\.p12/);
  assert.doesNotMatch(common, /b3fc0972-d9b2-451b-ae12-e2e543636954/);
});

test('shared release implementation isolates output and validates the mounted DMG payload', () => {
  assert.match(common, /dist-electron\.backup-/);
  assert.match(common, /AIDCP-\$\{version\}-arm64\.dmg/);
  assert.match(common, /hdiutil attach "\$dmg" -nobrowse -readonly/);
  assert.match(common, /aidcpCloudDefaultEnv !== 'ol'/);
  assert.match(common, /verify-signed-macos-artifacts\.cjs/);
  assert.match(common, /adspower-browser\/sqlite\/arm64\/node_sqlite3\.node/);
  assert.match(common, /file "\$artifact" \| grep -q 'arm64'/);
  assert.match(common, /codesign --verify --deep --strict/);
});

test('checkout gate preserves unrelated untracked files but rejects build inputs', () => {
  assert.match(common, /git status --porcelain --untracked-files=no/);
  assert.match(
    common,
    /git ls-files --others --exclude-standard -- src native scripts/,
  );
  assert.match(
    common,
    /Preserving unrelated untracked paths outside packaged source inputs/,
  );
  assert.match(common, /untracked build-related source files must be committed or moved/);
  assert.doesNotMatch(common, /git status --porcelain"\)/);
});

test('signed-only mode skips notary credentials without failing the build', () => {
  assert.match(
    common,
    /\[ "\$MODE" = "notarized" \] \|\| return 0/,
  );
});

test('notarized mode orders app notarization before DMG creation and notarization', () => {
  const appNotary = common.indexOf('notarize-and-staple.sh" "$app"');
  const prepackaged = common.indexOf('--prepackaged "$app_dir"');
  const dmgNotary = common.indexOf('notarize-and-staple.sh" "$dmg"');
  assert.ok(appNotary > 0);
  assert.ok(prepackaged > appNotary);
  assert.ok(dmgNotary > prepackaged);
  assert.match(common, /xcrun stapler validate "\$app"/);
  assert.match(common, /spctl --assess --type exec --verbose=4 "\$app"/);
  assert.match(common, /xcrun stapler validate "\$dmg"/);
  assert.match(common, /signed only \(NOT notarized\)/);
  assert.match(common, /signed \+ notarized \+ stapled/);
});
