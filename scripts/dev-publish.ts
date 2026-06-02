import process from 'node:process';

import { attachToPage } from '../src/cdp/index.js';
import type { PublishRequestPayload } from '../src/comm/protocol.js';
import {
  buildContentInputRequest,
  buildEnterPublishPageRequest,
  buildSubmitPublishRequest,
  buildTagInputRequest,
  buildTitleInputRequest,
  PublishStepValidator,
  publishPost,
} from '../src/flows/publish-post.js';
import { AnchorCache } from '../src/locating/cache.js';
import { CloudElementSelector } from '../src/client/cloud-selector.js';
import { EdgeClient, type CloudWebSocketFactory } from '../src/client/edge-client.js';
import { LocatingEngine } from '../src/locating/engine.js';

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function requiredArg(name: string): string {
  const value = readArg(name);
  if (!value) {
    throw new Error(`missing required arg --${name}=...`);
  }
  return value;
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildPayload(): PublishRequestPayload {
  return {
    title: requiredArg('title'),
    content: requiredArg('content'),
    tags: parseTags(readArg('tags')),
  };
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function dumpPageDiagnostics(session: Awaited<ReturnType<typeof attachToPage>>): Promise<void> {
  const snapshot = await session.cdp.send<{
    result?: { value?: unknown };
    exceptionDetails?: { text: string };
  }>('Runtime.evaluate', {
    expression: `(() => {
      const pick = (el) => {
        if (!el) return null;
        return {
          tag: el.tagName?.toLowerCase?.() ?? null,
          role: el.getAttribute?.('role') ?? null,
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          placeholder: el.getAttribute?.('placeholder') ?? null,
          ariaLabel: el.getAttribute?.('aria-label') ?? null,
          title: el.getAttribute?.('title') ?? null,
          href: el.getAttribute?.('href') ?? null,
          className: typeof el.className === 'string' ? el.className : null,
          contenteditable: el.getAttribute?.('contenteditable') ?? null,
          outerHTML: el.outerHTML?.slice(0, 400) ?? null,
        };
      };
      const all = Array.from(document.querySelectorAll('*'));
      const byKeywords = (keywords) =>
        all
          .filter((el) => {
            const text = [
              el.textContent,
              el.getAttribute('placeholder'),
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase();
            return keywords.some((kw) => text.includes(kw));
          })
          .slice(0, 8)
          .map(pick);
      return {
        url: location.href,
        title: document.title,
        imageRequiredSignals: byKeywords(['上传图片', '上传图文', '图片']),
        titleCandidates: byKeywords(['标题', 'title']),
        contentCandidates: byKeywords(['正文', '写点什么', '内容']),
        tagCandidates: byKeywords(['标签', '话题']),
        submitCandidates: byKeywords(['发布', '确认发布']),
      };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify({ step: 'page_diagnostics', snapshot: snapshot.result?.value ?? null }));
}

async function currentUrl(session: Awaited<ReturnType<typeof attachToPage>>): Promise<string> {
  const res = await session.cdp.send<{
    result?: { value?: unknown };
    exceptionDetails?: { text: string };
  }>('Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  });
  return typeof res.result?.value === 'string' ? res.result.value : '';
}

async function navigateCurrentPageToPublish(
  session: Awaited<ReturnType<typeof attachToPage>>,
): Promise<void> {
  await session.cdp.send('Page.navigate', {
    url: 'https://creator.xiaohongshu.com/publish/publish?source=official',
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await session.cdp.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', {
      expression: `(() => ({
        href: location.href,
        readyState: document.readyState,
        bodyText: document.body ? document.body.innerText.slice(0, 500) : ''
      }))()`,
      returnByValue: true,
    });
    const value = (state.result?.value ?? {}) as {
      href?: string;
      readyState?: string;
      bodyText?: string;
    };
    if (
      value.href?.includes('creator.xiaohongshu.com/publish') &&
      value.readyState === 'complete' &&
      /发布笔记|上传图文|上传视频|草稿箱/.test(value.bodyText ?? '')
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('navigate to creator publish timed out');
}

async function clickGraphicEntryAndWaitEditor(
  session: Awaited<ReturnType<typeof attachToPage>>,
): Promise<void> {
  await session.cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const target = all.find((el) => {
        const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        return text.includes('上传图文');
      });
      if (!target) return false;
      target.scrollIntoView({ block: 'center' });
      target.click();
      return true;
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await session.cdp.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', {
      expression: `(() => ({
        href: location.href,
        readyState: document.readyState,
        bodyText: document.body ? document.body.innerText.slice(0, 1000) : ''
      }))()`,
      returnByValue: true,
    });
    const value = (state.result?.value ?? {}) as {
      href?: string;
      readyState?: string;
      bodyText?: string;
    };
    if (
      value.readyState === 'complete' &&
      /标题|添加正文|上传图片|上传图文|发布/.test(value.bodyText ?? '')
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('enter graphic editor timed out');
}

function passthroughWsFactory(): CloudWebSocketFactory {
  return (url) => {
    const G = globalThis as unknown as { WebSocket?: new (u: string) => WebSocket };
    if (!G.WebSocket) {
      throw new Error('global WebSocket 不可用（需 Node>=22）');
    }
    return new G.WebSocket(url);
  };
}

async function main(): Promise<void> {
  const payload = buildPayload();
  const cloudUrl = process.env.AIDCP_CLOUD_URL ?? 'ws://121.89.85.150:8787';
  const edgeId = process.env.AIDCP_EDGE_ID ?? 'edge-local-dev-publish';
  const cdpHost = process.env.AIDCP_CDP_HOST ?? '127.0.0.1';
  const cdpPort = Number(process.env.AIDCP_CDP_PORT ?? 9222);
  const pageUrl = process.env.AIDCP_PAGE_URL;

  const attachOpts: Parameters<typeof attachToPage>[0] = { host: cdpHost, port: cdpPort };
  if (pageUrl) attachOpts.urlIncludes = pageUrl;
  let session = await attachToPage(attachOpts);
  await session.cdp.send('Input.enable').catch(() => undefined);

  const client = new EdgeClient({
    url: cloudUrl,
    edgeId,
    app: 'xhs',
    capabilities: ['locating', 'cdp', 'publish-dev'],
    runner: {
      run: async () => {
        throw new Error('dev-publish runner should not receive plan steps');
      },
    },
    wsFactory: passthroughWsFactory(),
  });
  await client.connect();

  const selector = new CloudElementSelector(client);
  const cache = new AnchorCache();
  const dryRun = hasFlag('dry-run');

  try {
    if (dryRun) {
      const deps = {
        dom: session.dom,
        executor: session.executor,
        selector,
        cache,
      };
      const steps = [
        ['enter_publish_page', buildEnterPublishPageRequest()],
        ['input_title', buildTitleInputRequest(payload.title)],
        ['input_content', buildContentInputRequest(payload.content)],
        ...payload.tags.map((tag) => ['input_tag', buildTagInputRequest(tag), tag] as const),
      ] as const;
      for (const step of steps) {
        const [stepName, req, currentTag] = step;
        const validator = new PublishStepValidator({
          step: stepName,
          payload,
          currentTag,
        });
        const engine = new LocatingEngine({ ...deps, validator }, {});
        const result = await engine.resolveAndAct(req);
        if (stepName === 'enter_publish_page') {
          await navigateCurrentPageToPublish(session);
          await clickGraphicEntryAndWaitEditor(session);
          console.log(
            JSON.stringify({
              step: 'enter_publish_page',
              result,
              navigatedUrl: await currentUrl(session),
            }),
          );
        } else {
          console.log(JSON.stringify({ step: stepName, result }));
        }
        if (!result.ok) {
          await dumpPageDiagnostics(session);
          process.exitCode = 1;
          return;
        }
      }
      const root = await session.dom.getRoot();
      const submitValidator = new PublishStepValidator({ step: 'submit_publish', payload });
      console.log(
        JSON.stringify({
          step: 'submit_publish_preview',
          validatorReady: submitValidator.validate(buildSubmitPublishRequest(), root),
        }),
      );
      process.exitCode = 0;
      return;
    }

    const result = await publishPost(
      {
        dom: session.dom,
        executor: session.executor,
        selector,
        cache,
      },
      {},
      payload,
    );
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    client.close();
    session.close();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});