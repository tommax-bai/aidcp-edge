/**
 * FileInputSetter — 把本地文件喂给发布页 <input type=file> 的接缝（publish-media-upload）。
 *
 * 设计要点：
 * - 文件 <input> 不可被 JS 值注入（浏览器安全），唯一可靠机制是 CDP DOM.setFileInputFiles，
 *   它写入真实 FileList 并触发原生 input/change 事件、对隐藏/零尺寸 input 亦生效。
 * - 抽成接口是为了：① 单测可注入 FakeFileInputSetter（"整段 locate+set" 的桩，因为现有 engine 调用
 *   都用 returnByValue:true、拿不到节点句柄，桩须替整段）；② 未来远程/转发 CDP 的唯一替换点。
 * - 真实 DOM 的文件输入选择器待实机 CDP 校准（inputSelector 可注入）。
 */

/** CDP send 最小子集（与 CdpClient.send 同构，便于单测打桩）。 */
export interface CdpLike {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface FileInputSetResult {
  ok: boolean;
  /** 失败原因：no_target（定位不到文件输入）/ engine_error（CDP 异常）。 */
  error?: string;
}

export interface FileInputSetter {
  /** 定位发布页文件输入并设置本地绝对路径文件；成功 ok:true，定位不到 no_target，CDP 异常 engine_error。 */
  setFiles(absPaths: string[]): Promise<FileInputSetResult>;
}

interface RuntimeEvalResult {
  result?: { objectId?: string; subtype?: string };
}

export interface CdpFileInputSetterOptions {
  /** 解析文件输入的 in-page 表达式（待实机校准；缺省取页面首个 input[type=file]）。 */
  inputSelector?: string;
}

/** 真实 CDP 实现：DOM.enable（once）→ Runtime.evaluate 取 objectId → DOM.setFileInputFiles。 */
export class CdpFileInputSetter implements FileInputSetter {
  private domEnabled = false;
  private readonly expression: string;

  constructor(
    private readonly cdp: CdpLike,
    options: CdpFileInputSetterOptions = {},
  ) {
    this.expression = options.inputSelector ?? "document.querySelector('input[type=file]')";
  }

  async setFiles(absPaths: string[]): Promise<FileInputSetResult> {
    try {
      if (!this.domEnabled) {
        await this.cdp.send('DOM.enable');
        this.domEnabled = true;
      }
      const objectId = await this.resolveInputObjectId();
      if (!objectId) return { ok: false, error: 'no_target' };
      try {
        await this.cdp.send('DOM.setFileInputFiles', { files: absPaths, objectId });
      } catch {
        // SPA 在解析与设置之间重渲染 → 句柄失效。单次有界重解析重试（不无限循环）。
        const retryId = await this.resolveInputObjectId();
        if (!retryId) return { ok: false, error: 'no_target' };
        await this.cdp.send('DOM.setFileInputFiles', { files: absPaths, objectId: retryId });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `engine_error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async resolveInputObjectId(): Promise<string | undefined> {
    // querySelector 命中 → result.objectId；未命中（null）→ 无 objectId（subtype:'null'）。
    const res = await this.cdp.send<RuntimeEvalResult>('Runtime.evaluate', {
      expression: this.expression,
      returnByValue: false,
    });
    return res?.result?.objectId;
  }
}
