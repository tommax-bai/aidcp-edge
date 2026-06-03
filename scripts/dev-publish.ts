import process from 'node:process';
import { writeFileSync } from 'node:fs';

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

const XHS_CREATOR_PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';
const DEFAULT_IMAGE_PATH = '/tmp/aidcp-test-image.png';
const DEFAULT_READY_SCREENSHOT = '/tmp/aidcp-publish-ready2.png';

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
    images: readArg('image') ? [readArg('image')!] : undefined,
  };
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function shouldRealPublish(): boolean {
  return process.env.AIDCP_REAL_PUBLISH === 'true';
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

async function detectEditorReady(
  session: Awaited<ReturnType<typeof attachToPage>>,
): Promise<{
  ok: boolean;
  snapshot: {
    href: string;
    titleValue: string | null;
    hasTitleInput: boolean;
    hasProseMirror: boolean;
    bodyText: string;
  };
}> {
  const res = await session.cdp.send<{
    result?: { value?: unknown };
    exceptionDetails?: { text: string };
  }>('Runtime.evaluate', {
    expression: `(() => {
      const titleInput = document.querySelector('input.d-text');
      const proseMirror = document.querySelector('div.tiptap.ProseMirror');
      const bodyText = document.body ? document.body.innerText.slice(0, 1200) : '';
      return {
        href: location.href,
        titleValue: titleInput instanceof HTMLInputElement ? titleInput.value : null,
        hasTitleInput: !!titleInput,
        hasProseMirror: !!proseMirror,
        bodyText,
      };
    })()`,
    returnByValue: true,
  });
  const snapshot = (res.result?.value ?? {
    href: '',
    titleValue: null,
    hasTitleInput: false,
    hasProseMirror: false,
    bodyText: '',
  }) as {
    href: string;
    titleValue: string | null;
    hasTitleInput: boolean;
    hasProseMirror: boolean;
    bodyText: string;
  };
  const ok =
    snapshot.hasTitleInput ||
    snapshot.hasProseMirror ||
    /图片编辑|智能标题/.test(snapshot.bodyText);
  return { ok, snapshot };
}

async function navigateCurrentPageToPublish(
  session: Awaited<ReturnType<typeof attachToPage>>,
): Promise<void> {
  await session.cdp.send('Page.navigate', {
    url: XHS_CREATOR_PUBLISH_URL,
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

async function clickGraphicEntryAndWaitImageInput(
  session: Awaited<ReturnType<typeof attachToPage>>,
): Promise<{ imageInputIndex: number; nodeId: number }> {
  let snapshot: Array<Record<string, unknown>> = [];
  let visibleGraphic: Record<string, unknown> | undefined;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const tabsDump = await session.cdp.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', {
      expression: `(() => {
        return Array.from(document.querySelectorAll('div,span')).map((el) => {
          const cls = typeof el.className === 'string' ? el.className : '';
          if (!/creator-tab|title/.test(cls)) return null;
          const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            className: cls,
            text,
            style: el.getAttribute('style') || '',
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        }).filter(Boolean);
      })()`,
      returnByValue: true,
    });
    snapshot = (tabsDump.result?.value ?? []) as Array<Record<string, unknown>>;
    console.log(JSON.stringify({ step: 'upload_graphic_leaf_dump', snapshot }));
    visibleGraphic = snapshot
      .filter((node) => String(node.tag ?? '') === 'DIV' && String(node.className ?? '').includes('creator-tab'))
      .filter((node) => String(node.text ?? '').includes('上传图文'))
      .filter((node) => Number(node.x) >= 0 && Number(node.y) >= 0 && Number(node.width) > 0 && Number(node.height) > 0)
      .filter((node) => !/left:\s*-9999px|top:\s*-9999px/.test(String(node.style ?? '')))
      .sort((a, b) => Number(a.width) * Number(a.height) - Number(b.width) * Number(b.height))[0];
    if (visibleGraphic) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!visibleGraphic) {
    const dumpPath = '/tmp/aidcp-select-page-dump.json';
    const pageSnapshot = await session.cdp.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', {
      expression: `(() => ({
        href: location.href,
        bodyText: document.body ? document.body.innerText.slice(0, 500) : '',
        creatorTabs: Array.from(document.querySelectorAll('div,span')).map((el) => {
          const cls = typeof el.className === 'string' ? el.className : '';
          if (!/creator-tab|title/.test(cls)) return null;
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            className: cls,
            text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
            style: el.getAttribute('style') || '',
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        }).filter(Boolean)
      }))()`,
      returnByValue: true,
    });
    writeFileSync(dumpPath, JSON.stringify(pageSnapshot.result?.value ?? null, null, 2));
    console.log(JSON.stringify({ step: 'select_page_dump', path: dumpPath, snapshot: pageSnapshot.result?.value ?? null }));
    throw new Error(`visible upload graphic card not found: ${JSON.stringify(snapshot)}`);
  }
  console.log(JSON.stringify({ step: 'graphic_click_target', target: visibleGraphic }));
  const x = Number(visibleGraphic.x) + Number(visibleGraphic.width) / 2;
  const y = Number(visibleGraphic.y) + Number(visibleGraphic.height) / 2;
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }).catch(() => undefined);
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });

  let imageInputIndex: number | null = null;
  for (let tick = 1; tick <= 10; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const poll = await session.cdp.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', {
      expression: `(() => ({
        href: location.href,
        fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((el, index) => ({
          index,
          accept: el.getAttribute('accept'),
          className: typeof el.className === 'string' ? el.className : '',
          hidden: el.hidden,
          display: getComputedStyle(el).display,
          visibility: getComputedStyle(el).visibility,
          opacity: getComputedStyle(el).opacity,
          parentText: (el.parentElement?.textContent || '').replace(/\\s+/g,' ').trim().slice(0,120)
        }))
      }))()`,
      returnByValue: true,
    });
    const snapshotValue = (poll.result?.value ?? null) as {
      href?: string;
      fileInputs?: Array<{ index: number; accept?: string | null }>;
    } | null;
    console.log(JSON.stringify({ step: 'poll_after_real_click', tick, snapshot: snapshotValue }));
    const imageInput = snapshotValue?.fileInputs?.find((item) =>
      /image|png|jpg|jpeg|webp/i.test(item.accept ?? ''),
    );
    if (imageInput) {
      imageInputIndex = imageInput.index;
      break;
    }
  }
  if (imageInputIndex === null) {
    throw new Error('image input not found after clicking upload graphic');
  }
  const root = await session.cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', {
    depth: -1,
    pierce: true,
  });
  const query = await session.cdp.send<{ nodeIds: number[] }>('DOM.querySelectorAll', {
    nodeId: root.root.nodeId,
    selector: 'input[type="file"]',
  });
  const nodeId = query.nodeIds[imageInputIndex];
  console.log(JSON.stringify({ step: 'image_input_node', imageInputIndex, nodeId }));
  return { imageInputIndex, nodeId };
}

async function uploadImageAndWaitEditor(
  session: Awaited<ReturnType<typeof attachToPage>>,
  imagePath: string,
): Promise<void> {
  const { imageInputIndex, nodeId } = await clickGraphicEntryAndWaitImageInput(session);
  await session.cdp.send('DOM.setFileInputFiles', { nodeId, files: [imagePath] });
  console.log(JSON.stringify({ step: 'set_file_input_files', file: imagePath, nodeId }));
  const dispatchRes = await session.cdp.send<{
    result?: { value?: unknown };
    exceptionDetails?: { text: string };
  }>('Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelectorAll('input[type="file"]')[${imageInputIndex}];
      if (!input) return { found: false };
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        found: true,
        filesLength: input.files ? input.files.length : null,
        accept: input.accept || null,
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify({ step: 'dispatch_input_change', snapshot: dispatchRes.result?.value ?? null }));
  for (let tick = 1; tick <= 20; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = await session.cdp.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', {
      expression: `(() => {
        const visibleButtons = Array.from(document.querySelectorAll('button,[role="button"],div,span')).map((el) => {
          const text = (el.textContent || '').replace(/\\s+/g,' ').trim();
          const rect = el.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
          return visible && text ? {tag: el.tagName, className: typeof el.className === 'string' ? el.className : '', text: text.slice(0,120), x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null;
        }).filter(Boolean).slice(0,60);
        const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map((el, index) => ({
          index,
          accept: el.getAttribute('accept'),
          filesLength: el.files ? el.files.length : null,
          className: typeof el.className === 'string' ? el.className : '',
          parentText: (el.parentElement?.textContent || '').replace(/\\s+/g,' ').trim().slice(0,120)
        }));
        const overlays = Array.from(document.querySelectorAll('*')).map((el) => {
          const text = (el.textContent || '').replace(/\\s+/g,' ').trim();
          if (!text) return null;
          const cls = typeof el.className === 'string' ? el.className : '';
          if (!(/确定|下一步|完成裁剪|裁剪|上传中|处理中|完成/.test(text) || /crop|modal|dialog|loading|progress/i.test(cls))) return null;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;
          return {tag: el.tagName, className: cls, text: text.slice(0,200), x: rect.x, y: rect.y, width: rect.width, height: rect.height};
        }).filter(Boolean).slice(0,30);
        return {
          href: location.href,
          readyState: document.readyState,
          title: document.title,
          bodyText: document.body ? document.body.innerText.slice(0, 2500) : '',
          fileInputs,
          overlays,
          visibleButtons
        };
      })()`,
      returnByValue: true,
    });
    const snapshot = state.result?.value ?? null;
    console.log(JSON.stringify({ step: 'poll_after_set_files', tick, snapshot }));
    const overlayButton = (snapshot as { overlays?: Array<{ text?: string; x: number; y: number; width: number; height: number }> } | null)?.overlays?.find((item) =>
      /确定|下一步|完成裁剪/.test(item.text ?? ''),
    );
    if (overlayButton) {
      const x = overlayButton.x + overlayButton.width / 2;
      const y = overlayButton.y + overlayButton.height / 2;
      await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }).catch(() => undefined);
      await session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      console.log(JSON.stringify({ step: 'click_overlay_button', target: overlayButton, clickPoint: { x, y } }));
    }
  }
}

async function fillEditorFields(
  session: Awaited<ReturnType<typeof attachToPage>>,
  payload: PublishRequestPayload,
): Promise<void> {
  const titlePoint = await session.cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('input.d-text[placeholder="填写标题会有更多赞哦"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`,
    returnByValue: true,
  });
  const titleCoords = titlePoint.result?.value as { x: number; y: number } | null;
  if (!titleCoords) throw new Error('title input not found');
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: titleCoords.x, y: titleCoords.y, button: 'none' }).catch(() => undefined);
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: titleCoords.x, y: titleCoords.y, button: 'left', clickCount: 1 });
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: titleCoords.x, y: titleCoords.y, button: 'left', clickCount: 1 });
  await session.cdp.send('Input.insertText', { text: payload.title });
  const titleRead = await session.cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('input.d-text[placeholder="填写标题会有更多赞哦"]');
      return el ? { value: el.value, placeholder: el.getAttribute('placeholder'), className: el.className } : null;
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify({ step: 'title_filled', snapshot: titleRead.result?.value ?? null }));

  const contentPoint = await session.cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('div.tiptap.ProseMirror[contenteditable="true"][role="textbox"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x + 20, y: rect.y + 20 };
    })()`,
    returnByValue: true,
  });
  const contentCoords = contentPoint.result?.value as { x: number; y: number } | null;
  if (!contentCoords) throw new Error('content editor not found');
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: contentCoords.x, y: contentCoords.y, button: 'none' }).catch(() => undefined);
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: contentCoords.x, y: contentCoords.y, button: 'left', clickCount: 1 });
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: contentCoords.x, y: contentCoords.y, button: 'left', clickCount: 1 });
  await session.cdp.send('Input.insertText', { text: payload.content }).catch(async () => {
    const fallback = await session.cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('div.tiptap.ProseMirror[contenteditable="true"][role="textbox"]');
        if (!el) return { ok: false };
        el.focus();
        document.execCommand('insertText', false, ${JSON.stringify(payload.content)});
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(payload.content)} }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, text: (el.textContent || '').replace(/\\s+/g, ' ').trim() };
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(JSON.stringify({ step: 'content_insert_fallback', snapshot: fallback.result?.value ?? null }));
  });
  const contentRead = await session.cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('div.tiptap.ProseMirror[contenteditable="true"][role="textbox"]');
      return el ? { textContent: (el.textContent || '').replace(/\\s+/g, ' ').trim(), innerText: (el.innerText || '').replace(/\\s+/g, ' ').trim(), className: el.className } : null;
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify({ step: 'content_filled', snapshot: contentRead.result?.value ?? null }));

  const topicPoint = await session.cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('button.contentBtn.topic-btn');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`,
    returnByValue: true,
  });
  const topicCoords = topicPoint.result?.value as { x: number; y: number } | null;
  if (!topicCoords) throw new Error('topic button not found');
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: topicCoords.x, y: topicCoords.y, button: 'none' }).catch(() => undefined);
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: topicCoords.x, y: topicCoords.y, button: 'left', clickCount: 1 });
  await session.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: topicCoords.x, y: topicCoords.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await session.cdp.send('Input.insertText', { text: payload.tags[0] ?? '' });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const topicRead = await session.cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression: `(() => ({
      dropdowns: Array.from(document.querySelectorAll('*')).map((el) => {
        const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        const rect = el.getBoundingClientRect();
        if (!text || rect.width <= 0 || rect.height <= 0) return null;
        if (!/测试|话题|添加话题/.test(text)) return null;
        return { tag: el.tagName, className: typeof el.className === 'string' ? el.className : '', text: text.slice(0, 160), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }).filter(Boolean).slice(0, 20),
      selectedTopics: Array.from(document.querySelectorAll('*')).map((el) => {
        const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        const rect = el.getBoundingClientRect();
        if (!text || rect.width <= 0 || rect.height <= 0) return null;
        if (!/^#/.test(text) && !/测试/.test(text)) return null;
        return { tag: el.tagName, className: typeof el.className === 'string' ? el.className : '', text: text.slice(0, 120), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }).filter(Boolean).slice(0, 20)
    }))()`,
    returnByValue: true,
  });
  console.log(JSON.stringify({ step: 'topic_state', snapshot: topicRead.result?.value ?? null }));
  await session.cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
    key: 'Escape',
    code: 'Escape',
  }).catch(() => undefined);
  await session.cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
    key: 'Escape',
    code: 'Escape',
  }).catch(() => undefined);
}

async function probeSubmitButton(
  session: Awaited<ReturnType<typeof attachToPage>>,
): Promise<{
  href: string;
  exactPublish: unknown[];
  exactLeave: unknown[];
  textMatches: unknown[];
  selectorCandidates: unknown[];
  shadowMatches: unknown[];
  cdpPierceMatches: unknown[];
  sameFooter: boolean;
}> {
  await session.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 1440,
    screenHeight: 1080,
  }).catch(() => undefined);
  console.log(JSON.stringify({ step: 'viewport_override', snapshot: { width: 1440, height: 1080 } }));
  const footerDump = await session.cdp.send<{
    result?: { value?: unknown };
    exceptionDetails?: { text: string };
  }>('Runtime.evaluate', {
    expression: `(() => {
      const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();
      const rectOf = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2,
        };
      };
      const chainOf = (el) => {
        const chain = [];
        let cur = el;
        for (let i = 0; i < 6 && cur; i += 1) {
          chain.push({
            tag: cur.tagName,
            className: typeof cur.className === 'string' ? cur.className : '',
            text: normalize(cur.textContent).slice(0, 120),
          });
          cur = cur.parentElement;
        }
        return chain;
      };
      const isLeafText = (el) => {
        const own = normalize(el.textContent);
        if (!own) return false;
        const childText = Array.from(el.children).some((child) => normalize(child.textContent));
        return !childText;
      };
      const cssPath = (el) => {
        if (!(el instanceof Element)) return null;
        const parts = [];
        let cur = el;
        while (cur && parts.length < 6) {
          let part = cur.tagName.toLowerCase();
          if (cur.id) {
            part += '#' + cur.id;
            parts.unshift(part);
            break;
          }
          const cls = typeof cur.className === 'string'
            ? cur.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2)
            : [];
          if (cls.length) part += '.' + cls.join('.');
          parts.unshift(part);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      };
      const deepCollect = () => {
        const out = [];
        const walk = (node, hostChain = []) => {
          if (!node) return;
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node;
            out.push({ el, hostChain });
            if (el.shadowRoot) {
              walk(el.shadowRoot, hostChain.concat([{
                tag: el.tagName,
                className: typeof el.className === 'string' ? el.className : '',
                selector: cssPath(el),
              }]));
            }
          }
          const children = node instanceof ShadowRoot || node instanceof Document || node instanceof Element
            ? Array.from(node.children || [])
            : [];
          for (const child of children) walk(child, hostChain);
        };
        walk(document, []);
        return out;
      };
      const textMatches = Array.from(document.querySelectorAll('*'))
        .map((el) => {
          const text = normalize(el.textContent);
          if (!text || (!text.includes('发布') && !text.includes('暂存离开'))) return null;
          const rect = rectOf(el);
          if (rect.width <= 0 || rect.height <= 0) return null;
          return {
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className : '',
            text,
            disabled: (el).disabled === true,
            ariaDisabled: el.getAttribute?.('aria-disabled'),
            rect,
            chain: chainOf(el),
            childTexts: Array.from(el.children).map((child) => normalize(child.textContent)).filter(Boolean),
          };
        })
        .filter(Boolean);
      const shadowMatches = deepCollect()
        .map(({ el, hostChain }) => {
          const text = normalize(el.textContent);
          if (text !== '发布' && text !== '暂存离开') return null;
          if (!isLeafText(el)) return null;
          const rect = rectOf(el);
          if (rect.width <= 0 || rect.height <= 0) return null;
          return {
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className : '',
            text,
            disabled: (el).disabled === true,
            ariaDisabled: el.getAttribute?.('aria-disabled'),
            rect,
            chain: chainOf(el),
            hostChain,
          };
        })
        .filter(Boolean);
      const exactPublish = Array.from(document.querySelectorAll('*'))
        .filter((el) => normalize(el.textContent) === '发布')
        .filter((el) => isLeafText(el))
        .map((el) => {
          const rect = rectOf(el);
          return {
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className : '',
            text: '发布',
            disabled: (el).disabled === true,
            ariaDisabled: el.getAttribute?.('aria-disabled'),
            rect,
            chain: chainOf(el),
          };
        })
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
      const exactLeave = Array.from(document.querySelectorAll('*'))
        .filter((el) => normalize(el.textContent) === '暂存离开')
        .filter((el) => isLeafText(el))
        .map((el) => {
          const rect = rectOf(el);
          return {
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className : '',
            text: '暂存离开',
            disabled: (el).disabled === true,
            ariaDisabled: el.getAttribute?.('aria-disabled'),
            rect,
            chain: chainOf(el),
          };
        })
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
      const selectorCandidates = Array.from(
        document.querySelectorAll(
          [
            'button[class*="red"]',
            'button[class*="submit"]',
            'button[class*="publish"]',
            '[class*="footer"] button',
            '[class*="publish-footer"] button',
            '[class*="btn-submit"] button',
            '[class*="btn-submit"]',
          ].join(','),
        ),
      ).map((el) => {
        const rect = rectOf(el);
        return {
          tag: el.tagName,
          className: typeof el.className === 'string' ? el.className : '',
          text: normalize(el.textContent).slice(0, 120),
          disabled: (el).disabled === true,
          ariaDisabled: el.getAttribute?.('aria-disabled'),
          rect,
          chain: chainOf(el),
        };
      });
      const sameFooter =
        exactPublish.length > 0 &&
        exactLeave.length > 0 &&
        exactPublish[0].chain[1]?.className === exactLeave[0].chain[1]?.className;
      return { exactPublish, exactLeave, textMatches, selectorCandidates, shadowMatches, sameFooter, href: location.href };
    })()`,
    returnByValue: true,
  });
  const pierceTree = await session.cdp.send<{
    root: Record<string, unknown>;
  }>('DOM.getDocument', {
    depth: -1,
    pierce: true,
  });
  const snapshot = (footerDump.result?.value ?? null) as {
    href: string;
    exactPublish: unknown[];
    exactLeave: unknown[];
    textMatches: unknown[];
    selectorCandidates: unknown[];
    shadowMatches: unknown[];
    sameFooter: boolean;
  } | null;
  const cdpPierceMatches: Array<Record<string, unknown>> = [];
  const walkNode = (node: Record<string, unknown>, chain: string[] = []): void => {
    const nodeName = String(node.nodeName ?? '');
    const nodeValue = String(node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    const attrs = Array.isArray(node.attributes) ? node.attributes : [];
    const classIndex = attrs.findIndex((item) => item === 'class');
    const className =
      classIndex >= 0 && typeof attrs[classIndex + 1] === 'string' ? String(attrs[classIndex + 1]) : '';
    const nextChain = nodeName ? chain.concat([`${nodeName}${className ? '.' + className : ''}`]) : chain;
    if (nodeValue === '发布' || nodeValue === '暂存离开') {
      cdpPierceMatches.push({
        nodeName,
        nodeValue,
        backendNodeId: node.backendNodeId ?? null,
        nodeId: node.nodeId ?? null,
        chain: nextChain,
      });
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      walkNode(child as Record<string, unknown>, nextChain);
    }
    const shadowRoots = Array.isArray(node.shadowRoots) ? node.shadowRoots : [];
    for (const shadow of shadowRoots) {
      walkNode(shadow as Record<string, unknown>, nextChain.concat(['#shadow-root']));
    }
  };
  walkNode(pierceTree.root);
  console.log(JSON.stringify({ step: 'footer_publish_probe', snapshot }, null, 2));
  console.log(JSON.stringify({ step: 'footer_publish_probe_cdp', snapshot: cdpPierceMatches }, null, 2));
  const screenshot = await session.cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  });
  writeFileSync(DEFAULT_READY_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  console.log(JSON.stringify({ step: 'capture_screenshot', path: DEFAULT_READY_SCREENSHOT }));
  return snapshot ?? {
    href: '',
    exactPublish: [],
    exactLeave: [],
    textMatches: [],
    selectorCandidates: [],
    shadowMatches: [],
    cdpPierceMatches: [],
    sameFooter: false,
  };
}

async function probeEditorControls(session: Awaited<ReturnType<typeof attachToPage>>): Promise<void> {
  for (let tick = 1; tick <= 12; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = await session.cdp.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', {
      expression: `(() => {
        const pick = (selector) => Array.from(document.querySelectorAll(selector)).map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className : '',
            role: el.getAttribute('role'),
            placeholder: el.getAttribute('placeholder'),
            ariaLabel: el.getAttribute('aria-label'),
            contenteditable: el.getAttribute('contenteditable'),
            text: (el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,160),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          };
        }).filter((el) => el.width > 0 && el.height > 0).slice(0,30);
        const rich = Array.from(document.querySelectorAll('*')).map((el) => {
          const cls = typeof el.className === 'string' ? el.className : '';
          if (!/(editor|text|title|content|topic)/i.test(cls)) return null;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;
          return {
            tag: el.tagName,
            className: cls,
            role: el.getAttribute('role'),
            placeholder: el.getAttribute('placeholder'),
            ariaLabel: el.getAttribute('aria-label'),
            contenteditable: el.getAttribute('contenteditable'),
            text: (el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,160),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          };
        }).filter(Boolean).slice(0,60);
        const publishButtons = Array.from(document.querySelectorAll('button,[role="button"],div,span')).map((el) => {
          const text = (el.textContent || '').replace(/\\s+/g,' ').trim();
          const rect = el.getBoundingClientRect();
          if (!text || rect.width <= 0 || rect.height <= 0) return null;
          if (!/发布/.test(text)) return null;
          return {
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className : '',
            role: el.getAttribute('role'),
            text: text.slice(0,120),
            disabled: (el as HTMLButtonElement).disabled === true,
            ariaDisabled: el.getAttribute('aria-disabled'),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          };
        }).filter(Boolean).slice(0,20);
        return {
          href: location.href,
          readyState: document.readyState,
          title: document.title,
          bodyText: document.body ? document.body.innerText.slice(0, 2500) : '',
          contenteditable: pick('[contenteditable="true"]'),
          roleTextbox: pick('div[role="textbox"]'),
          richCandidates: rich,
          publishButtons
        };
      })()`,
      returnByValue: true,
    });
    console.log(JSON.stringify({ step: 'editor_probe', tick, snapshot: state.result?.value ?? null }));
  }
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
      const steps = [['enter_publish_page', buildEnterPublishPageRequest()]] as const;
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
          await uploadImageAndWaitEditor(session, payload.images?.[0] ?? DEFAULT_IMAGE_PATH);
          await probeEditorControls(session);
          await fillEditorFields(session, payload);
          const footerProbe = await probeSubmitButton(session);
          const editorReady = await detectEditorReady(session);
          console.log(
            JSON.stringify({
              step: 'enter_publish_page',
              result: editorReady.ok
                ? {
                    ok: true,
                    mode: 'editor_state_override',
                    originalResult: result,
                  }
                : result,
              editorReady,
              footerProbe,
              navigatedUrl: await currentUrl(session),
            }),
          );
          if (!editorReady.ok || !footerProbe.exactPublish.length) {
            await dumpPageDiagnostics(session);
            process.exitCode = 1;
            return;
          }
          process.exitCode = 0;
          return;
        } else {
          console.log(JSON.stringify({ step: stepName, result }));
          if (!result.ok) {
            await dumpPageDiagnostics(session);
            process.exitCode = 1;
            return;
          }
        }
        if (stepName === 'enter_publish_page') {
          continue;
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
    if (!shouldRealPublish()) {
      console.log(JSON.stringify({ ok: false, error: '[submit_publish] blocked_by_AIDCP_REAL_PUBLISH=false' }));
      process.exitCode = 1;
      return;
    }
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