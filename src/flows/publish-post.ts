import { LocatingEngine } from '../locating/engine.js';
export type { PublishResultPayload } from '../comm/protocol.js';
import type { PublishResultPayload } from '../comm/protocol.js';

/** 旧整页发布载荷。其消息类型 publish.request 已随 change drop-dead-cloud-edge-commands 从协议删除
 * （云端零发送点、生产无处理器）；本退役代文件及其复用方仍以此形状传参，故在此自持定义。 */
export interface PublishRequestPayload {
  title: string;
  content: string;
  tags: string[];
  images?: string[];
}
import type {
  ActionRequest,
  ActionResult,
  PostValidator,
} from '../locating/index.js';
import type { EngineDeps, EngineOptions } from '../locating/engine.js';
import {
  XHS_PUBLISH_CONTENT_ACTION_ID,
  XHS_PUBLISH_CONTENT_ANCHOR_HINT,
  XHS_PUBLISH_CONTENT_GOAL,
  XHS_PUBLISH_ENTRY_ACTION_ID,
  XHS_PUBLISH_ENTRY_ANCHOR_HINT,
  XHS_PUBLISH_ENTRY_GOAL,
  XHS_PUBLISH_SUBMIT_ACTION_ID,
  XHS_PUBLISH_SUBMIT_ANCHOR_HINT,
  XHS_PUBLISH_SUBMIT_GOAL,
  XHS_PUBLISH_TAG_ACTION_ID,
  XHS_PUBLISH_TAG_ANCHOR_HINT,
  XHS_PUBLISH_TAG_GOAL,
  XHS_PUBLISH_TITLE_ACTION_ID,
  XHS_PUBLISH_TITLE_ANCHOR_HINT,
  XHS_PUBLISH_TITLE_GOAL,
} from './anchors.js';
import {
  waitForPublishApproval,
  type PublishApprovalGateOptions,
} from '../publish/approval-gate.js';

type PublishStep =
  | 'enter_publish_page'
  | 'input_title'
  | 'input_content'
  | 'input_tag'
  | 'submit_publish'
  | 'validate_publish';

interface PublishStepContext {
  step: PublishStep;
  payload: PublishRequestPayload;
  currentTag?: string;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isDocumentRoot(root: Element | Document): root is Document {
  return 'documentElement' in root;
}

function rootElement(root: Element | Document): Element {
  return isDocumentRoot(root) ? (root.body ?? root.documentElement) : root;
}

function collectTextSignals(el: Element): string[] {
  return [
    el.textContent,
    el.getAttribute('aria-label'),
    el.getAttribute('title'),
    el.getAttribute('placeholder'),
    el.getAttribute('value'),
    el.getAttribute('data-placeholder'),
  ]
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function isTextEntryElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('role') === 'textbox'
  );
}

function findElementByKeywords(
  root: Element | Document,
  keywords: string[],
  predicate?: (el: Element) => boolean,
): Element | null {
  const all = Array.from(rootElement(root).querySelectorAll('*'));
  for (const el of all) {
    if (predicate && !predicate(el)) continue;
    const signals = collectTextSignals(el);
    if (signals.some((signal) => keywords.some((kw) => signal.includes(normalizeText(kw))))) {
      return el;
    }
  }
  return null;
}

function findElementByKeywordsDeep(
  root: Element | Document,
  keywords: string[],
  predicate?: (el: Element) => boolean,
): Element | null {
  const start = rootElement(root);
  const queue: Array<Element | ShadowRoot> = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const elements = Array.from(current.querySelectorAll('*'));
    for (const el of elements) {
      if (predicate && !predicate(el)) continue;
      const signals = collectTextSignals(el);
      if (signals.some((signal) => keywords.some((kw) => signal.includes(normalizeText(kw))))) {
        return el;
      }
      if ((el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) {
        queue.push((el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot!);
      }
    }
  }
  return null;
}

function findActionElement(root: Element | Document, actionId: string): Element | null {
  return rootElement(root).querySelector(`[data-action-id="${actionId}"]`);
}

function findTextEntryByActionId(root: Element | Document, actionId: string): Element | null {
  const el = findActionElement(root, actionId);
  return el && isTextEntryElement(el) ? el : null;
}

function readInputValue(el: Element | null): string {
  if (!el) return '';
  if (isTextEntryElement(el) && 'value' in el) {
    return typeof el.value === 'string' ? el.value : '';
  }
  return el.getAttribute('value') ?? el.textContent ?? '';
}

export function extractPostId(root: Element | Document): string | undefined {
  const all = Array.from(rootElement(root).querySelectorAll('*'));
  for (const el of all) {
    for (const attr of ['data-post-id', 'data-note-id', 'data-id', 'data-postid']) {
      const value = el.getAttribute(attr);
      if (value && value.trim()) return value.trim();
    }
  }
  const hrefEl = all.find((el) => {
    const href = el.getAttribute('href') ?? '';
    return /\/(explore|notes?)\/([\w-]+)/i.test(href);
  });
  if (hrefEl) {
    const href = hrefEl.getAttribute('href') ?? '';
    const match = href.match(/\/(?:explore|notes?)\/([\w-]+)/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** 完整小红书分享链接（必含 xsec_token 才算可点开）的匹配式。 */
const XHS_SHARE_URL_RE = /https?:\/\/[^\s"'<>]*xiaohongshu\.com\/[^\s"'<>]*xsec_token=[^\s"'<>]+/i;

/**
 * 抓「带 xsec_token 的完整小红书详情页分享 URL」（可点开真实笔记，供后台跳转）。
 * 只回**含 xsec_token** 的完整绝对链接；抓不到则 undefined——诚实置空，绝不用裸 id 拼一个缺 token、
 * 打不开的假链接冒充（change publish-history-account-and-detail，红线：不派生假值）。
 */
export function extractPostUrl(root: Element | Document): string | undefined {
  const scope = rootElement(root);
  const candidates: string[] = [];
  // 1) 规范链接 / og:url（发布成功页常带的可分享绝对地址）。
  const canonical = scope.querySelector('link[rel="canonical"]')?.getAttribute('href');
  if (canonical) candidates.push(canonical);
  const ogUrl = scope.querySelector('meta[property="og:url"]')?.getAttribute('content');
  if (ogUrl) candidates.push(ogUrl);
  // 2) 任意 <a href> / 复制链接控件里出现的完整分享链接。
  for (const el of Array.from(scope.querySelectorAll('a[href], [data-share-url], [data-url], input[value]'))) {
    const v =
      el.getAttribute('href') ??
      el.getAttribute('data-share-url') ??
      el.getAttribute('data-url') ??
      el.getAttribute('value');
    if (v) candidates.push(v);
  }
  for (const url of candidates) {
    const m = url.match(XHS_SHARE_URL_RE);
    if (m) return m[0];
  }
  return undefined;
}

function isPublishPage(root: Element | Document): boolean {
  return Boolean(
    findElementByKeywords(root, ['填写标题会有更多赞哦', '标题', '填写标题', '输入标题']) ||
      findElementByKeywords(root, ['正文', '写点什么', '添加正文', '输入正文', '图片编辑', '智能标题']) ||
      findElementByKeywords(root, ['发布笔记', '发图文', '上传图文']) ||
      findElementByKeywords(root, ['暂存离开', '定时发布', '笔记预览']) ||
      findElementByKeywords(root, ['添加标签', '添加话题', '话题']) ||
      findActionElement(root, XHS_PUBLISH_TITLE_ACTION_ID) ||
      findActionElement(root, XHS_PUBLISH_CONTENT_ACTION_ID) ||
      findActionElement(root, XHS_PUBLISH_SUBMIT_ACTION_ID),
  );
}

export class PublishStepValidator implements PostValidator {
  constructor(private readonly context: PublishStepContext) {}

  validate(_req: ActionRequest, root: Element | Document): boolean {
    switch (this.context.step) {
      case 'enter_publish_page':
        return isPublishPage(root);
      case 'input_title': {
        const titleEl =
          findTextEntryByActionId(root, XHS_PUBLISH_TITLE_ACTION_ID) ??
          findElementByKeywords(root, ['填写标题会有更多赞哦', '标题', '填写标题', '输入标题'], (el) =>
            isTextEntryElement(el),
          );
        return normalizeText(readInputValue(titleEl)).includes(normalizeText(this.context.payload.title));
      }
      case 'input_content': {
        const contentEl = findTextEntryByActionId(root, XHS_PUBLISH_CONTENT_ACTION_ID);
        if (contentEl) {
          return normalizeText(readInputValue(contentEl)).includes(
            normalizeText(this.context.payload.content),
          );
        }
        const fallback = findElementByKeywords(
          root,
          ['正文', '写点什么', '添加正文', '输入正文', 'ProseMirror'],
          (el) => isTextEntryElement(el),
        );
        return normalizeText(readInputValue(fallback)).includes(normalizeText(this.context.payload.content));
      }
      case 'input_tag': {
        const tag = this.context.currentTag;
        if (!tag) return false;
        const all = Array.from(rootElement(root).querySelectorAll('*'));
        return all.some((el) => {
          const signals = collectTextSignals(el);
          return signals.some((signal) => signal.includes(normalizeText(tag)));
        });
      }
      case 'submit_publish':
      case 'validate_publish':
        return Boolean(
          extractPostId(root) ||
            findElementByKeywordsDeep(root, ['发布', '暂存离开', '立即发布', '确认发布']) ||
            findElementByKeywordsDeep(root, ['publish', 'submit']),
        );
      default:
        return false;
    }
  }
}

/** 话题文本规整：strip 前导 #、去所有空白、小写。用于话题 token 精确比对。 */
function normalizeTopic(value: string | null | undefined): string {
  return (value ?? '').replace(/^#+/, '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 是否已在正文编辑器里生成「真话题 token」（change split-topic-roles，实机校准）。
 * XHS 提交话题后正文出现 `a.tiptap-topic[data-topic]`（文本 `#话题名`，`data-topic.name` = 话题名）。
 * 断言存在文本或 `data-topic.name` 与 keyword 匹配的 token；仅有纯文本 `#keyword`（未从下拉提交）→ false，
 * 治「静默假成功」（老 input_tag 校验只查全局子串，纯文本也误判成功）。
 */
export function committedTopicPill(root: Element | Document, keyword: string): boolean {
  const kw = normalizeTopic(keyword);
  if (!kw) return false;
  const scope = rootElement(root);
  const pills = Array.from(scope.querySelectorAll('a.tiptap-topic, a[data-topic]'));
  for (const p of pills) {
    // token 文本形如「#话题名」，另含隐藏后缀 span.content-hide「[话题]#」——比对前先剔除该后缀。
    const hidden = p.querySelector('.content-hide');
    let rawText = p.textContent ?? '';
    if (hidden?.textContent) rawText = rawText.replace(hidden.textContent, '');
    const text = normalizeTopic(rawText);
    let name = '';
    const dt = p.getAttribute('data-topic');
    if (dt) {
      try {
        name = normalizeTopic(JSON.parse(dt).name);
      } catch {
        /* data-topic 非法 JSON：忽略、只按文本比对 */
      }
    }
    // 精确匹配（**非子串**）：子串会把已存在的「#考研数学」误判成「考研」已贴上——正是本 change 要杜绝的静默假成功。
    if (name === kw || text === kw) return true;
  }
  return false;
}

/** 话题真 token 后置校验器（断言真话题 token，非全局子串）。供 runAddTopic 后置校验与测试复用。 */
export function topicPillValidator(keyword: string): PostValidator {
  return { validate: (_req: ActionRequest, root: Element | Document) => committedTopicPill(root, keyword) };
}

export function buildEnterPublishPageRequest(): ActionRequest {
  return {
    actionId: XHS_PUBLISH_ENTRY_ACTION_ID,
    op: 'click',
    goal: XHS_PUBLISH_ENTRY_GOAL,
    anchorHint: XHS_PUBLISH_ENTRY_ANCHOR_HINT,
  };
}

export function buildTitleInputRequest(title: string): ActionRequest {
  return {
    actionId: XHS_PUBLISH_TITLE_ACTION_ID,
    op: 'input',
    value: title,
    goal: XHS_PUBLISH_TITLE_GOAL,
    anchorHint: XHS_PUBLISH_TITLE_ANCHOR_HINT,
  };
}

export function buildContentInputRequest(content: string): ActionRequest {
  return {
    actionId: XHS_PUBLISH_CONTENT_ACTION_ID,
    op: 'input',
    value: content,
    goal: XHS_PUBLISH_CONTENT_GOAL,
    anchorHint: XHS_PUBLISH_CONTENT_ANCHOR_HINT,
  };
}

export function buildTagInputRequest(tag: string): ActionRequest {
  return {
    actionId: XHS_PUBLISH_TAG_ACTION_ID,
    op: 'input',
    value: tag,
    goal: `${XHS_PUBLISH_TAG_GOAL} 当前要加入的标签是「${tag}」。`,
    anchorHint: XHS_PUBLISH_TAG_ANCHOR_HINT,
  };
}

export function buildSubmitPublishRequest(): ActionRequest {
  return {
    actionId: XHS_PUBLISH_SUBMIT_ACTION_ID,
    op: 'click',
    goal: XHS_PUBLISH_SUBMIT_GOAL,
    anchorHint: XHS_PUBLISH_SUBMIT_ANCHOR_HINT,
  };
}

async function runStep(
  deps: Omit<EngineDeps, 'validator'> & { validator?: PostValidator },
  options: EngineOptions,
  req: ActionRequest,
  context: PublishStepContext,
): Promise<ActionResult> {
  const validator = deps.validator ?? new PublishStepValidator(context);
  const engine = new LocatingEngine({ ...deps, validator }, options);
  return engine.resolveAndAct(req);
}

function stepError(step: PublishStep, result: ActionResult): PublishResultPayload {
  return {
    ok: false,
    error: `[${step}] ${result.reason}`,
  };
}

export async function publishPost(
  deps: Omit<EngineDeps, 'validator'> & { validator?: PostValidator },
  options: EngineOptions = {},
  payload: PublishRequestPayload,
  approvalGate?: PublishApprovalGateOptions,
): Promise<PublishResultPayload> {
  if ((payload.images?.length ?? 0) > 0) {
    // v1 整页路径无上传步骤：带图 MUST 显式改道指令驱动路径（upload_image），绝不静默丢图后假成功（红线）。
    return { ok: false, error: '[images] use command-driven path (upload_image) for images; v1 page path cannot upload' };
  }

  const enter = await runStep(
    deps,
    options,
    buildEnterPublishPageRequest(),
    { step: 'enter_publish_page', payload },
  );
  if (!enter.ok) return stepError('enter_publish_page', enter);

  const title = await runStep(
    deps,
    options,
    buildTitleInputRequest(payload.title),
    { step: 'input_title', payload },
  );
  if (!title.ok) return stepError('input_title', title);

  const content = await runStep(
    deps,
    options,
    buildContentInputRequest(payload.content),
    { step: 'input_content', payload },
  );
  if (!content.ok) return stepError('input_content', content);

  for (const tag of payload.tags) {
    const tagResult = await runStep(
      deps,
      options,
      buildTagInputRequest(tag),
      { step: 'input_tag', payload, currentTag: tag },
    );
    if (!tagResult.ok) return stepError('input_tag', tagResult);
  }

  if (approvalGate) {
    const approval = await waitForPublishApproval(approvalGate);
    if (!approval.ok) {
      return {
        ok: false,
        error: `[approval_gate] ${approval.reason ?? 'approval_failed'} requestId=${approval.requestId}`,
      };
    }
  }

  const submit = await runStep(
    deps,
    options,
    buildSubmitPublishRequest(),
    { step: 'submit_publish', payload },
  );
  if (!submit.ok) return stepError('submit_publish', submit);

  const root = await deps.dom.getRoot();
  const finalValidator = new PublishStepValidator({ step: 'validate_publish', payload });
  if (!finalValidator.validate(buildSubmitPublishRequest(), root)) {
    return { ok: false, error: '[validate_publish] post_validate_failed' };
  }
  const postId = extractPostId(root);
  if (!postId) {
    return { ok: false, error: '[validate_publish] missing_post_id' };
  }
  return { ok: true, postId };
}