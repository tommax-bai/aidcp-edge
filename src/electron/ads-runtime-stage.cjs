const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_MANIFEST = 'aidcp-runtime-template.json';
const TEMPLATE_MANIFEST_SCHEMA = 1;

function sortedEntries(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function computeTemplateIdentity(root) {
  const hash = crypto.createHash('sha256');
  const walk = (dir, relativeDir = '') => {
    for (const entry of sortedEntries(dir)) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (relative === TEMPLATE_MANIFEST) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        walk(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink\0${relative}\0${fs.readlinkSync(absolute)}\0`);
      } else if (entry.isFile()) {
        hash.update(`file\0${relative}\0`);
        hash.update(fs.readFileSync(absolute));
        hash.update('\0');
      }
    }
  };
  walk(root);
  return `sha256:${hash.digest('hex')}`;
}

function readPackageVersion(root) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
}

function writeTemplateManifest(root) {
  const manifest = {
    schema: TEMPLATE_MANIFEST_SCHEMA,
    packageVersion: readPackageVersion(root),
    contentIdentity: computeTemplateIdentity(root),
  };
  fs.writeFileSync(path.join(root, TEMPLATE_MANIFEST), `${JSON.stringify(manifest)}\n`);
  return manifest;
}

function readTemplateManifest(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, TEMPLATE_MANIFEST), 'utf8'));
    if (
      manifest?.schema === TEMPLATE_MANIFEST_SCHEMA
      && typeof manifest.contentIdentity === 'string'
      && /^sha256:[0-9a-f]{64}$/.test(manifest.contentIdentity)
    ) {
      return {
        schema: TEMPLATE_MANIFEST_SCHEMA,
        packageVersion: String(manifest.packageVersion || readPackageVersion(root)),
        contentIdentity: manifest.contentIdentity,
      };
    }
  } catch {
    /* Existing development templates predate the manifest. */
  }
  return {
    schema: TEMPLATE_MANIFEST_SCHEMA,
    packageVersion: readPackageVersion(root),
    contentIdentity: computeTemplateIdentity(root),
  };
}

function resolveRuntimeTemplateSource({ resourcesPath, appRoot, isPackaged = false } = {}) {
  const resourceTemplate = resourcesPath ? path.join(resourcesPath, 'adspower-browser') : null;
  const developmentTemplate = appRoot ? path.join(appRoot, 'build', 'ads-runtime', 'adspower-browser') : null;
  const candidates = isPackaged
    ? [resourceTemplate, developmentTemplate]
    : [developmentTemplate, resourceTemplate];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function sameStamp(actual, expected) {
  return actual?.schema === expected.schema
    && actual?.appVersion === expected.appVersion
    && actual?.packageVersion === expected.packageVersion
    && actual?.contentIdentity === expected.contentIdentity;
}

function readStageStamp(stampPath) {
  try {
    return JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch {
    return null;
  }
}

function removeBestEffort(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* Cleanup failure must not hide the primary staging result. */
  }
}

async function stageRuntimeTemplate({ source, destRoot, appVersion, stopExisting } = {}) {
  if (!source || !fs.existsSync(source)) return { ok: true, skipped: 'no-template' };

  const dest = path.join(destRoot, 'adspower-browser');
  const stampPath = path.join(destRoot, 'stage.json');
  let stamp;
  try {
    const template = readTemplateManifest(source);
    stamp = {
      schema: TEMPLATE_MANIFEST_SCHEMA,
      appVersion: String(appVersion || ''),
      packageVersion: template.packageVersion,
      contentIdentity: template.contentIdentity,
    };
    fs.mkdirSync(destRoot, { recursive: true });
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    return { ok: false, error: `指纹浏览器运行时暂存失败：${detail}` };
  }
  if (fs.existsSync(dest) && sameStamp(readStageStamp(stampPath), stamp)) {
    return { ok: true, staged: false, dest, stamp };
  }

  const suffix = `${process.pid}-${Date.now()}`;
  const candidate = path.join(destRoot, `.adspower-browser.next-${suffix}`);
  const backup = path.join(destRoot, `.adspower-browser.previous-${suffix}`);
  const stampCandidate = path.join(destRoot, `.stage.next-${suffix}.json`);
  let movedPrevious = false;
  let installedCandidate = false;

  try {
    fs.cpSync(source, candidate, { recursive: true, force: false, errorOnExist: true });
    if (fs.existsSync(dest) && stopExisting) {
      const stopped = await stopExisting({ cliEntry: path.join(dest, 'cli', 'index.js') });
      if (!stopped?.ok) throw new Error(stopped?.error || '旧 Ads CLI daemon 停止失败');
    }
    if (fs.existsSync(dest)) {
      fs.renameSync(dest, backup);
      movedPrevious = true;
    }
    fs.renameSync(candidate, dest);
    installedCandidate = true;
    fs.writeFileSync(stampCandidate, `${JSON.stringify(stamp)}\n`);
    fs.renameSync(stampCandidate, stampPath);
    removeBestEffort(backup);
    return { ok: true, staged: true, dest, stamp };
  } catch (error) {
    removeBestEffort(stampCandidate);
    if (installedCandidate) removeBestEffort(dest);
    if (movedPrevious && fs.existsSync(backup) && !fs.existsSync(dest)) {
      try {
        fs.renameSync(backup, dest);
      } catch {
        /* Preserve the backup path for manual recovery and report the original failure. */
      }
    }
    removeBestEffort(candidate);
    const detail = error && error.message ? error.message : String(error);
    return { ok: false, error: `指纹浏览器运行时暂存失败：${detail}` };
  }
}

module.exports = {
  TEMPLATE_MANIFEST,
  TEMPLATE_MANIFEST_SCHEMA,
  computeTemplateIdentity,
  writeTemplateManifest,
  readTemplateManifest,
  resolveRuntimeTemplateSource,
  stageRuntimeTemplate,
};
