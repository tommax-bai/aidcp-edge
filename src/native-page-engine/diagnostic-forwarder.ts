/**
 * 引擎诊断行的**盖章、限量与排版**层。
 *
 * 分工的理由（design D4）：传输层不知道哪条在飞记录是命令 —— 控制记录（开窗回执、端点应答）
 * 会与命令并存在同一张 pending 表里，所以「pending 只有一条」不等于「命令只有一条」，
 * 在传输层按条数推断归因就是把「不知道」写成「知道」。运行时知道自己此刻在执行什么，归因归它。
 *
 * 两条不许松动的：
 *   - 没有在飞命令时（建会话 / 重连 / 关闭期）如实标 `cmd=none`，**绝不挂到相邻命令上**。
 *   - 到量之后**绝不闭嘴**。只转发前 N 行然后安静下来，读起来和「引擎从第 N+1 行起没再说话」
 *     完全一样 —— 那是「静默假成功」在可观测性上的同形。
 */
import type { NativeEngineDiagnosticLine, NativeEngineDiagnosticSink } from './client.js';

/**
 * 行前缀。**不用裸 JSON**：外壳侧已有先例把结构化前缀行的原始内容挡在 `edge.log` 之外
 *（那条分支只留固定安全痕迹），而引擎诊断按契约是有界无页面内容的、**应当**原样落盘。
 * 走人类可读的普通日志行，正好绕开那个矛盾，也不必去扩另一套双写的枚举校验。
 */
export const ENGINE_DIAGNOSTIC_PREFIX = '[engine-diagnostic]';

/** 单条命令内最多转发多少行。超出的部分计数而不逐行转发，并在命令结束时如实报出。 */
export const MAX_FORWARDED_LINES_PER_COMMAND = 50;

/** 无在飞命令时的归因值。它是一个**结论**（确实没有命令在飞），不是「没查出来」。 */
export const NO_COMMAND_LABEL = 'none';

const MAX_COMMAND_LABEL_CHARS = 64;

export interface EngineDiagnosticForwarder {
  /**
   * 注入给引擎客户端的那**一个**出口。装配闸按引用核对它，因此必须是稳定的同一个函数对象。
   */
  readonly sink: NativeEngineDiagnosticSink;
  /** 一条命令开始执行。此前「命令之间」那一段的抑制计数在这里结账。 */
  beginCommand(label: string): void;
  /** 一条命令结束执行。本命令抑制掉的行数在这里如实报出。 */
  endCommand(): void;
  /** 收摊：把还没结账的抑制计数冲出去，不留悬空。 */
  flush(): void;
  /** 当前归因标签，供断言与排障读取。 */
  currentCommand(): string;
}

/** 归因标签只允许标识符字符 —— 它要出现在一行 `key=value` 里，不能自带空格把行格式撑破。 */
export function sanitizeCommandLabel(label: string): string {
  const safe = String(label ?? '')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, MAX_COMMAND_LABEL_CHARS);
  return safe || NO_COMMAND_LABEL;
}

/**
 * 控制字符替换成 `?`。这是**排版安全**，不是内容校验 —— 宿主分不出哪个 token 是引擎生成的、
 * 哪个是页面派生的，所以本层从不声称自己验过内容（那是引擎侧的义务）。
 */
function sanitizeText(text: string): string {
  let sanitized = '';
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0) ?? 0;
    // 控制字符（含 DEL）会把一行在终端里重写掉，换成一个可见占位。
    sanitized += code < 0x20 || code === 0x7f ? '?' : char;
  }
  return sanitized;
}

/**
 * 一条转发行的渲染结果：`[engine-diagnostic] cmd=<label> seq=<n> class=<known|other> <text>`，
 * 截断 / 不完整时各自多一个显式标记。标记只在成立时出现 —— 出现即事实。
 */
export function renderEngineDiagnosticLine(
  command: string,
  line: NativeEngineDiagnosticLine,
): string {
  const marks = [
    ...(line.truncated ? ['truncated=1'] : []),
    ...(line.incomplete ? ['incomplete=1'] : []),
  ];
  return [
    ENGINE_DIAGNOSTIC_PREFIX,
    `cmd=${sanitizeCommandLabel(command)}`,
    `seq=${line.seq}`,
    `class=${line.kind}`,
    ...marks,
    sanitizeText(line.text),
  ].join(' ');
}

/** 到量的那一刻就喊一声，不等命令结束 —— 命令要是再也没结束，读者也不该被蒙在鼓里。 */
export function renderEngineDiagnosticBoundReached(command: string, limit: number): string {
  return `${ENGINE_DIAGNOSTIC_PREFIX} cmd=${sanitizeCommandLabel(command)} class=host forward_bound_reached=${limit}`;
}

/** 结账行：本段一共压掉了多少行。`class=host` 表明这行是宿主写的，不是引擎写的。 */
export function renderEngineDiagnosticSuppression(
  command: string,
  suppressed: number,
  limit: number,
): string {
  return `${ENGINE_DIAGNOSTIC_PREFIX} cmd=${sanitizeCommandLabel(command)} class=host suppressed=${suppressed} limit=${limit}`;
}

/**
 * 建一个转发器。`write` 收到的是**整行、不含换行**，落到哪里由调用方决定。
 * 纯状态机 + 纯渲染，脱机可断言：不碰文件系统、不碰 `console`、不认识进程。
 */
export function createEngineDiagnosticForwarder(
  write: (line: string) => void,
  limit: number = MAX_FORWARDED_LINES_PER_COMMAND,
): EngineDiagnosticForwarder {
  const bound = Math.max(1, Math.floor(limit));
  let command = NO_COMMAND_LABEL;
  let forwarded = 0;
  let suppressed = 0;
  let announced = false;

  const settleSegment = (): void => {
    if (suppressed > 0) write(renderEngineDiagnosticSuppression(command, suppressed, bound));
    forwarded = 0;
    suppressed = 0;
    announced = false;
  };

  // 稳定的同一个函数对象：装配闸按引用核对的就是它。
  const sink: NativeEngineDiagnosticSink = (line) => {
    if (forwarded >= bound) {
      // 保留**最早**的 N 行而不是最新的：排障要的是第一次出问题的现场。
      suppressed += 1;
      if (!announced) {
        announced = true;
        write(renderEngineDiagnosticBoundReached(command, bound));
      }
      return;
    }
    forwarded += 1;
    write(renderEngineDiagnosticLine(command, line));
  };

  return {
    sink,
    beginCommand(label: string): void {
      settleSegment();
      command = sanitizeCommandLabel(label);
    },
    endCommand(): void {
      settleSegment();
      command = NO_COMMAND_LABEL;
    },
    flush(): void {
      settleSegment();
    },
    currentCommand(): string {
      return command;
    },
  };
}
