import { LocatingEngine } from '../locating/engine.js';
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

export interface PublishRequestPayload {
  title: string;
  content: string;
  tags: string[];
  images?: string[];
}

export interface PublishResultPayload {
  ok: boolean;
  postId?: string;
  error?: string;
}

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
  return tag === 'input' || tag === 'textarea' || el.getAttribute('contenteditable') === 'true';
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

function extractPostId(root: Element | Document): string | undefined {
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

export class PublishStepValidator implements PostValidator {
  constructor(private readonly context: PublishStepContext) {}

  validate(_req: ActionRequest, root: Element | Document): boolean {
    switch (this.context.step) {
      case 'enter_publish_page':
        return Boolean(
          findElementByKeywords(root, ['标题', '填写标题', '输入标题']) ||
            findElementByKeywords(root, ['正文', '写点什么', '添加正文']),
        );
      case 'input_title': {
        const titleEl =
          findTextEntryByActionId(root, XHS_PUBLISH_TITLE_ACTION_ID) ??
          findElementByKeywords(root, ['标题', '填写标题', '输入标题'], (el) =>
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
          ['正文', '写点什么', '添加正文', '输入正文'],
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
        return Boolean(extractPostId(root));
      default:
        return false;
    }
  }
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
): Promise<PublishResultPayload> {
  if ((payload.images?.length ?? 0) > 0) {
    return { ok: false, error: '[images] images are not supported in phase one' };
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