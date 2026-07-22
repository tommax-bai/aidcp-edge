import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  NativePageEngineClient,
  type NativePageCommand,
  type NativePageCommandExecution,
  type NativePageEngineManifest,
  type NativePageEngineSession,
} from './client.js';

export interface NativePageEndpoint { host: string; port: number }

export interface NativePageRuntimeOptions {
  binaryPath: string;
  getEndpoint(): NativePageEndpoint;
  expectedManifest: NativePageEngineManifest;
  processTimeoutMs?: number;
}

interface OpenOwner {
  ownerId: string;
  session: NativePageEngineSession;
}

export class NativePageRuntime {
  private readonly client: NativePageEngineClient;
  private owner?: OpenOwner;
  private tail: Promise<void> = Promise.resolve();
  private activeAbort?: AbortController;

  constructor(private readonly options: NativePageRuntimeOptions) {
    this.client = new NativePageEngineClient({
      binaryPath: options.binaryPath,
      processTimeoutMs: options.processTimeoutMs ?? 31_000,
      expectedManifest: options.expectedManifest,
    });
  }

  static fromEnvironment(getEndpoint: () => NativePageEndpoint): NativePageRuntime {
    const binaryPath = String(process.env.AIDCP_NATIVE_PAGE_ENGINE_BINARY ?? '').trim();
    if (!binaryPath || !isAbsolute(binaryPath)) {
      throw new Error('AIDCP_NATIVE_PAGE_ENGINE_BINARY is required for Xiaohongshu Native-only runtime');
    }
    const manifest = JSON.parse(readFileSync(join(dirname(binaryPath), 'manifest.json'), 'utf8')) as Record<string, unknown>;
    if (
      typeof manifest.engineVersion !== 'string'
      || manifest.platformAdapterVersion !== 'xiaohongshu-v1'
      || typeof manifest.capabilityDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(manifest.capabilityDigest)
    ) {
      throw new Error('Native Page Engine package manifest is invalid');
    }
    return new NativePageRuntime({
      binaryPath,
      getEndpoint,
      expectedManifest: {
        engineVersion: manifest.engineVersion,
        platformAdapterVersion: manifest.platformAdapterVersion,
        capabilityDigest: manifest.capabilityDigest,
      },
    });
  }

  execute(
    ownerId: string,
    command: NativePageCommand,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<NativePageCommandExecution> {
    return this.serial(async () => {
      const session = await this.sessionFor(ownerId);
      const controller = new AbortController();
      this.activeAbort = controller;
      const forwardAbort = (): void => controller.abort();
      signal?.addEventListener('abort', forwardAbort, { once: true });
      try {
        return await session.execute(command, timeoutMs, controller.signal);
      } finally {
        signal?.removeEventListener('abort', forwardAbort);
        if (this.activeAbort === controller) this.activeAbort = undefined;
      }
    });
  }

  async closeOwner(ownerId: string): Promise<void> {
    this.activeAbort?.abort();
    await this.serial(async () => {
      if (this.owner?.ownerId !== ownerId) return;
      const current = this.owner;
      this.owner = undefined;
      await current.session.close();
    });
  }

  async shutdown(): Promise<void> {
    this.activeAbort?.abort();
    await this.serial(async () => {
      const current = this.owner;
      this.owner = undefined;
      await current?.session.close();
    });
  }

  private async sessionFor(ownerId: string): Promise<NativePageEngineSession> {
    if (this.owner?.ownerId === ownerId) return this.owner.session;
    if (this.owner) {
      const old = this.owner;
      this.owner = undefined;
      await old.session.close();
    }
    const endpoint = this.options.getEndpoint();
    const suffix = ownerId.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'page';
    const session = await this.client.openSession({
      ...endpoint,
      platform: 'xiaohongshu',
      sessionId: `xhs_${process.pid}_${Date.now().toString(36)}`,
      taskId: suffix,
      timeoutMs: 30_000,
    });
    this.owner = { ownerId, session };
    return session;
  }

  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
}
