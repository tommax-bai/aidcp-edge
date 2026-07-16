import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WechatChannelsError } from './error-classifier.js';
import { masterKeyPath, resolveWechatStateRoot, sessionPath, type WechatLocalScope } from './local-paths.js';
import type { WechatSessionMaterial } from './types.js';

export interface WechatSessionBinding extends WechatLocalScope {
  accountId: string;
  finderIdentity: string;
}

interface StoredSessionRecord {
  version: 1;
  binding: WechatSessionBinding;
  identity: { externalId: string; displayName: string };
  session: WechatSessionMaterial;
  savedAt: number;
}

interface EncryptedEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  authTag: string;
  ciphertext: string;
  aadHash: string;
}

export interface LoadedWechatSession {
  binding: WechatSessionBinding;
  identity: StoredSessionRecord['identity'];
  session: WechatSessionMaterial;
  savedAt: number;
  legacyBindingMigrated: boolean;
}

export interface EncryptedSessionStoreOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  nowImpl?: () => number;
  randomBytesImpl?: (size: number) => Buffer;
}

export class EncryptedWechatSessionStore {
  private readonly rootDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;

  constructor(
    readonly scope: WechatLocalScope,
    options: EncryptedSessionStoreOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.rootDir = options.rootDir ?? resolveWechatStateRoot(this.env);
    this.now = options.nowImpl ?? Date.now;
    this.random = options.randomBytesImpl ?? randomBytes;
  }

  async save(params: {
    binding: WechatSessionBinding;
    identity: StoredSessionRecord['identity'];
    session: WechatSessionMaterial;
  }): Promise<void> {
    this.assertScope(params.binding);
    assertSessionMaterial(params.session);
    if (params.binding.finderIdentity !== params.identity.externalId) {
      throw new WechatChannelsError('identity_mismatch', 'session_store', 'Session identity does not match its binding', false);
    }
    const key = await this.loadMasterKey();
    const aad = this.aad();
    const iv = this.random(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const record: StoredSessionRecord = {
      version: 1,
      binding: params.binding,
      identity: params.identity,
      session: params.session,
      savedAt: this.now(),
    };
    const plaintext = Buffer.from(JSON.stringify(record), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      aadHash: createHash('sha256').update(aad).digest('hex'),
    };
    await atomicWrite(sessionPath(this.rootDir, this.scope), `${JSON.stringify(envelope)}\n`);
  }

  async load(expectedAccountId?: string): Promise<LoadedWechatSession | null> {
    const path = sessionPath(this.rootDir, this.scope);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new WechatChannelsError('auth_expired', 'session_store', 'Encrypted session could not be read', false);
    }
    try {
      const envelope = JSON.parse(text) as EncryptedEnvelope;
      if (
        envelope.version !== 1 ||
        envelope.algorithm !== 'aes-256-gcm' ||
        typeof envelope.iv !== 'string' ||
        typeof envelope.authTag !== 'string' ||
        typeof envelope.ciphertext !== 'string'
      ) {
        throw new Error('invalid envelope');
      }
      const aad = this.aad();
      const expectedAadHash = createHash('sha256').update(aad).digest('hex');
      if (envelope.aadHash !== expectedAadHash) throw new Error('scope mismatch');
      const key = await this.loadMasterKey();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const record = JSON.parse(plaintext) as StoredSessionRecord;
      if (record.version !== 1) throw new Error('unsupported version');
      this.assertScope(record.binding);
      assertSessionMaterial(record.session);
      if (record.binding.finderIdentity !== record.identity.externalId) throw new Error('identity binding mismatch');
      const legacyBindingMigrated = !!expectedAccountId && record.binding.accountId !== expectedAccountId &&
        record.binding.accountId === record.binding.finderIdentity;
      if (expectedAccountId && record.binding.accountId !== expectedAccountId && !legacyBindingMigrated) {
        throw new WechatChannelsError('identity_mismatch', 'session_store', 'Stored session belongs to another account', false);
      }
      const binding = legacyBindingMigrated
        ? { ...record.binding, accountId: expectedAccountId }
        : record.binding;
      return {
        binding,
        identity: record.identity,
        session: record.session,
        savedAt: record.savedAt,
        legacyBindingMigrated,
      };
    } catch (error) {
      if (error instanceof WechatChannelsError) throw error;
      throw new WechatChannelsError('auth_expired', 'session_store', 'Encrypted session failed authentication', false);
    }
  }

  async clear(): Promise<void> {
    await rm(sessionPath(this.rootDir, this.scope), { force: true });
  }

  private assertScope(binding: WechatSessionBinding): void {
    if (binding.envKey !== this.scope.envKey || binding.browserProfileId !== this.scope.browserProfileId) {
      throw new WechatChannelsError('identity_mismatch', 'session_store', 'Session scope does not match this environment', false);
    }
  }

  private aad(): Buffer {
    return Buffer.from(`wechat_channels|${this.scope.envKey}|${this.scope.browserProfileId}`, 'utf8');
  }

  private async loadMasterKey(): Promise<Buffer> {
    const fromEnv = this.env.AIDCP_WECHAT_MASTER_KEY?.trim();
    if (fromEnv) {
      const parsed = parseMasterKey(fromEnv);
      if (!parsed) throw new Error('AIDCP_WECHAT_MASTER_KEY must be 32 bytes encoded as hex or base64');
      return parsed;
    }
    const path = masterKeyPath(this.rootDir, this.env);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const existing = await readFile(path);
      if (existing.length !== 32) throw new Error('WeChat master key file must contain exactly 32 bytes');
      await chmod(path, 0o600).catch(() => undefined);
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const generated = this.random(32);
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(generated);
      } finally {
        await handle.close();
      }
      return generated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const winner = await readFile(path);
      if (winner.length !== 32) throw new Error('WeChat master key file must contain exactly 32 bytes');
      return winner;
    }
  }
}

function parseMasterKey(value: string): Buffer | null {
  if (/^[a-fA-F0-9]{64}$/.test(value)) return Buffer.from(value, 'hex');
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function assertSessionMaterial(session: WechatSessionMaterial): void {
  if (!session || !Array.isArray(session.cookies) || session.cookies.length === 0 || typeof session.userAgent !== 'string' ||
      session.requestContext?.version !== 1 || !session.requestContext.aid || !session.requestContext.pageUrl ||
      !session.requestContext.commonBody.rawKeyBuff || !session.requestContext.headers.fingerprintDeviceId ||
      !session.requestContext.headers.wechatUin) {
    throw new Error('invalid session material');
  }
  const allCookies = [...session.cookies, ...(session.dmCookies ?? [])];
  for (const cookie of allCookies) {
    const domain = cookie.domain?.replace(/^\./, '').toLowerCase();
    if (!cookie.name || !cookie.value || !domain || !(domain === 'weixin.qq.com' || domain.endsWith('.weixin.qq.com'))) {
      throw new Error('invalid scoped cookie');
    }
  }
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, data, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
}
