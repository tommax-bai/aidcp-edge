import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const main = readFileSync(join(root, 'src/electron/main.cjs'), 'utf8');
const renderer = readFileSync(join(root, 'src/electron/renderer/renderer.js'), 'utf8');

test('double-hop setting is default-off, normalized exactly and exposed as safe mode state', () => {
  assert.match(main, /systemProxyUpstreamEnabled:\s*false/);
  assert.match(main, /settings\.systemProxyUpstreamEnabled = settings\.systemProxyUpstreamEnabled === true/g);
  assert.match(main, /proxyMode: systemProxyChainEnabled\(\) \? 'system_then_environment' : 'direct'/);
  assert.match(
    main,
    /function systemProxyChainEnabled\(handle\)[\s\S]{0,500}?handle && handle\.child[\s\S]{0,300}?handle\.status\.proxyMode === 'system_then_environment'/,
    'running browser generations must keep their effective mode until restart',
  );
  assert.match(renderer, /saveSettings\(\{ systemProxyUpstreamEnabled: enabled \}\)/);
  assert.match(renderer, /proxyModePending[\s\S]{0,300}?currentStatus\.proxyMode === 'system_then_environment'/);
  assert.match(renderer, /status\.proxyMode === 'system_then_environment'/);
});

test('preflight and child spawn consume the same prepared loopback through a private authority pipe', () => {
  assert.match(main, /readProxy:\s*readProxyForPreflight/);
  assert.match(main, /await proxyChainManager\.ensure\(/);
  assert.match(main, /const endpoint = proxyChainManager\.endpoint\(handle\.profileId\)/);
  assert.match(
    main,
    /if \(handle\.proxyAuthority && handle\.status\.proxyMode === 'system_then_environment'\s*&& handle\.status\.proxyChainApplicable === true\s*&& !cleanupBootstrap\)/,
  );
  assert.match(main, /mode: 'system_then_environment'[\s\S]{0,180}?originalProxy: handle\.proxyAuthority[\s\S]{0,120}?relayPort: endpoint\.proxyPort[\s\S]{0,120}?authorityRevision: handle\.proxyAuthorityRevision/);
  assert.match(main, /spawnEnv\.AIDCP_ADS_PROXY_AUTHORITY_FD = '4'/);
  assert.match(main, /authorityPipe\.end\(JSON\.stringify\(proxyAuthorityPayload\)\)/);
  assert.doesNotMatch(main, /spawnEnv\.AIDCP_ADS_PROXY_OVERRIDE/);
  assert.match(main, /if \(!endpoint\) \{[\s\S]{0,180}?proxy_chain_unavailable[\s\S]{0,180}?return;/);
});

test('Cloud owns configured proxy authority; AdsPower may only classify explicit no_proxy', () => {
  assert.match(main, /createAdsProxyAuthorityStore\(/);
  assert.match(main, /async function readAuthoritativeProfileProxy\(/);
  assert.match(main, /\/proxy-authority`/);
  assert.match(main, /migrationAuthorityFromLocalRecord\(proxyAuthorityStore\.load\(id\)\)/);
  assert.match(main, /async function readAdsNoProxyAuthority\(profileId\)/);
  assert.match(main, /adsNoProxyAuthorityView\(result,\s*id\)/);
  assert.match(main, /proxyAuthority:\s*proxyAuthority\.authority/);
});

test('profiles without an environment proxy stay outside double-hop applicability', () => {
  const authorityStart = main.indexOf('async function readAuthoritativeProfileProxy');
  const authorityEnd = main.indexOf('async function projectAuthoritativeProxySummary', authorityStart);
  const authority = main.slice(authorityStart, authorityEnd);
  assert.ok(
    authority.indexOf('await readAdsNoProxyAuthority(id)') < authority.indexOf('clientAuthEnabled()'),
    'AdsPower explicit no_proxy must bypass Cloud availability and authority checks',
  );
  assert.match(
    main,
    /async function skipOfflineSystemProxyChain\(handle\)[\s\S]{0,500}?proxyChainManager\.invalidate\(handle\.profileId\)[\s\S]{0,300}?proxyMode: 'direct'[\s\S]{0,200}?proxyChainApplicable: false[\s\S]{0,200}?proxyChain: null/,
  );
  assert.match(
    main,
    /async function ensureSystemProxyChain\(handle, config\)[\s\S]{0,900}?if \(config\.noProxy\) \{\s*await skipOfflineSystemProxyChain\(handle\);\s*return \{ state: 'skipped', reason: 'no_proxy' \};\s*\}/,
  );
  assert.match(
    main,
    /async function readProxyForPreflight\(profileId\)[\s\S]{0,700}?if \(!systemProxyChainEnabled\(handle\) \|\| config\.noProxy\) return config;/,
  );
  assert.match(
    renderer,
    /chainNotApplicable = status && status\.proxyChainApplicable === false[\s\S]{0,800}?当前环境未配置代理，双跳不适用/,
  );
  assert.match(
    renderer,
    /const proxyModePending = running[\s\S]{0,250}?currentStatus\.proxyChainApplicable !== false/,
  );
});

test('relay lifecycle invalidates safe evidence and stops all sidecars before application exit', () => {
  assert.match(main, /const \{\s*invalidateEvidence = false,\s*\.\.\.safeSnapshot\s*\} = snapshot \|\| \{\}/);
  assert.match(main, /updateStatus\(handle, \{ proxyChain: safeSnapshot \}\)/);
  assert.match(main, /proxyPreflight\.invalidate\(envHandle\.envId\)/);
  assert.match(main, /proxyChainManager\.invalidate\(handle\.profileId\)/);
  assert.match(main, /await proxyChainManager\.stopAll\(\)/);
  assert.match(main, /const hasManagedProxyChains = proxyChainManager\.hasActive\(\)/);
});
