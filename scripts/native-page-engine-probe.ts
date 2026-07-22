import { resolve } from 'node:path';
import {
  NativePageEngineClient,
  NativePageEngineError,
} from '../src/native-page-engine/client.js';

interface CliOptions {
  binaryPath: string;
  host: string;
  port: number;
  timeoutMs: number;
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error('Usage: --binary <path> --port <port> [--host 127.0.0.1] [--timeout-ms 5000]');
    }
    values.set(flag, value);
  }
  const binary = values.get('--binary');
  const port = Number(values.get('--port'));
  const timeoutMs = Number(values.get('--timeout-ms') ?? '5000');
  if (!binary || !Number.isInteger(port)) {
    throw new Error('Both --binary and --port are required');
  }
  return {
    binaryPath: resolve(binary),
    host: values.get('--host') ?? '127.0.0.1',
    port,
    timeoutMs,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = new NativePageEngineClient({
    binaryPath: options.binaryPath,
    processTimeoutMs: options.timeoutMs + 1_000,
  });
  const result = await client.probePage({
    host: options.host,
    port: options.port,
    platform: 'xiaohongshu',
    timeoutMs: options.timeoutMs,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof NativePageEngineError) {
    process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message })}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
