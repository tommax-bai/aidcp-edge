import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROUTER_DIRECTORY = 'native/page-engine/src/facebook-router';

export async function readFacebookRouterSource(repoRoot: string): Promise<string> {
  const directory = resolve(repoRoot, ROUTER_DIRECTORY);
  const manifest = await readFile(resolve(directory, 'manifest.txt'), 'utf8');
  const fragments = manifest
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (fragments.length === 0 || new Set(fragments).size !== fragments.length) {
    throw new Error('Facebook router manifest must name a non-empty unique source set');
  }
  if (fragments.some((entry) => entry.includes('/') || entry.includes('\\'))) {
    throw new Error('Facebook router manifest entries must be local file names');
  }
  if (fragments.some((entry, index) => index > 0 && fragments[index - 1]! >= entry)) {
    throw new Error('Facebook router manifest entries must remain in lexical assembly order');
  }
  return (await Promise.all(
    fragments.map((entry) => readFile(resolve(directory, entry), 'utf8')),
  )).join('');
}
