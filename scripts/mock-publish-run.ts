/**
 * mock-publish-run.ts — 本地直驱发布序列（mock 飞书/云端编排），用于快速校准发布页各步 DOM。
 *
 * 绕过飞书触发 + 人审 + 云端 CommandSequencer：直接用固定测试内容逐条 dispatch 边缘 PublishCommandDispatcher。
 * 默认 **不提交**（停在 submit 前，留编辑器现场供肉眼检查）；加 --submit 才真正点发布。
 *
 * 用法：
 *   AIDCP_MOCK_IMG_URL='https://...png' npx tsx scripts/mock-publish-run.ts          # 跑到 submit 前
 *   AIDCP_MOCK_IMG_URL='https://...png' npx tsx scripts/mock-publish-run.ts --submit # 真发一条
 *
 * 红线：仅用于本机校准；不接飞书/云端；不伪造成功（每步如实打印 ok/error）。
 */

import { launchChrome, attachToPage } from '../src/cdp/index.js';
import { PublishCommandDispatcher } from '../src/flows/publish-command-handlers.js';
import { ImageUploader } from '../src/flows/image-uploader.js';
import { CdpFileInputSetter } from '../src/cdp/file-input-setter.js';
import { AnchorCache } from '../src/locating/cache.js';
import type { ElementSelector, ElementDescriptor, SelectionResult } from '../src/locating/index.js';
import type { PublishCommandPayload } from '../src/comm/protocol.js';

const IMG_URL = process.env.AIDCP_MOCK_IMG_URL ?? '';
const DO_SUBMIT = process.argv.includes('--submit');
const RECORD_ID = 999001;

// stub 选择器：不接云端 LLM；返回 null 让引擎只走 cache+matcher（anchorHint）。校准发布页特殊元素改用 cdp 直驱。
const stubSelector: ElementSelector = {
  async select(_goal: string, _els: ElementDescriptor[]): Promise<SelectionResult> {
    return { index: null, reason: 'mock-stub-no-llm' };
  },
};

const TITLE = '显存24G跑14B模型OOM实录';
const CONTENT =
  '显存24G跑14B模型，OOM到怀疑人生。试了量化、tensor parallel，最后发现是 max_model_len 默认拉满32k，KV cache 直接爆掉。调到8k居然能跑，吞吐还涨了。文档里这条藏得贼深，建议官方加粗。';

function cmd(seq: number, kind: PublishCommandPayload['kind'], params: PublishCommandPayload['params'] = {}): PublishCommandPayload {
  return { recordId: RECORD_ID, seq, kind, params };
}

async function main(): Promise<void> {
  if (!IMG_URL) {
    console.error('[mock] 缺 AIDCP_MOCK_IMG_URL（一张直链 https 图）');
    process.exitCode = 1;
    return;
  }
  console.log(`[mock] launch Chrome + attach（提交=${DO_SUBMIT}）...`);
  await launchChrome({});
  const session = await attachToPage({ urlIncludes: 'xiaohongshu' }).catch(() => attachToPage({}));

  const dispatcher = new PublishCommandDispatcher(
    { dom: session.dom, executor: session.executor, selector: stubSelector, cache: new AnchorCache() },
    {},
    Date.now,
    new ImageUploader({
      fileInputSetter: new CdpFileInputSetter(session.cdp, {
        inputSelector: "document.querySelector('input.upload-input[type=file]') || document.querySelector('input[type=file]')",
      }),
      dom: session.dom,
      hasThumbnail: (root) => {
        try {
          return Array.from(root.querySelectorAll('.img-preview-area img, img#creator-preview-image-0')).some(
            (img) => (img.getAttribute('src') || '').length > 0,
          );
        } catch {
          return false;
        }
      },
    }),
    session.cdp,
  );

  // 首次跑通只保留必需步骤（话题/可见范围为可选，待后续校准）。
  const sequence: PublishCommandPayload[] = [
    cmd(0, 'navigate_entry'),
    cmd(1, 'select_mode'),
    cmd(2, 'upload_image', { imageUrl: IMG_URL }),
    cmd(3, 'fill_field', { fieldType: 'title', value: TITLE }),
    cmd(4, 'fill_field', { fieldType: 'content', value: CONTENT }),
  ];
  if (DO_SUBMIT) {
    sequence.push(cmd(5, 'submit_publish'));
    sequence.push(cmd(6, 'capture_postId'));
  }

  for (const c of sequence) {
    const started = Date.now();
    const r = await dispatcher.dispatch(c);
    const ms = Date.now() - started;
    const tag = r.ok ? 'OK ' : 'FAIL';
    console.log(`[mock] ${tag} seq=${c.seq} ${c.kind}${c.params.fieldType ? '(' + c.params.fieldType + ')' : ''} ${ms}ms ${r.ok ? (r.value ? '→ ' + r.value : '') : '→ ' + r.error}`);
    if (!r.ok) {
      console.log(`[mock] 停在 ${c.kind}（error=${r.error}），现场保留在浏览器供检查。`);
      break;
    }
  }
  console.log('[mock] 完成（未关闭浏览器，便于检查现场）。');
  session.close();
}

main().catch((e) => {
  console.error('[mock] 失败:', e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
