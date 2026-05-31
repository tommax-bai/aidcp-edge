/**
 * 卡片预筛（本地快速判断，不调用 LLM）。
 *
 * 目的：explore feed 中大部分内容明显与人设（AI/LLM/工程师等）无关
 * （娱乐八卦、游戏、美食、穿搭等），打开 modal → 提取 → 调 Qwen API 单张耗时
 * 30-40s。通过卡片标题 / likes 在打开前快速过滤，省去无谓的开销。
 *
 * 设计原则：**宁可误放，不可误杀**。任何无法确定相关性的标题一律放行打开。
 * 仅当标题命中 IRRELEVANT_PATTERNS 且未命中 RELEVANT_KEYWORDS 时才跳过。
 *
 * 配置（RELEVANT_KEYWORDS / IRRELEVANT_PATTERNS）独立导出，日后可从云端动态下发更新。
 */

import type { NoteCard } from './feed-scroller.js';
import { parseCount } from './note-extractor.js';

/** likes 低于该值的卡片直接跳过（不值得打开 modal） */
export const MIN_LIKES = 50;

/**
 * 与人设兴趣对应的相关关键词（命中则一律放行，即使同时命中 IRRELEVANT）。
 * 对应 soul interests：AI / LLM / 大模型 / Agent / RAG / Prompt / 开源 / 编程等。
 */
export const RELEVANT_KEYWORDS: string[] = [
  'ai',
  'llm',
  '大模型',
  '模型',
  'agent',
  '智能体',
  'rag',
  'prompt',
  '提示词',
  '开源',
  'vllm',
  'gpt',
  'claude',
  'gemini',
  'deepseek',
  'qwen',
  '通义',
  '编程',
  '代码',
  'code',
  'coding',
  '算法',
  '工程师',
  '程序员',
  '开发',
  'developer',
  '机器学习',
  '深度学习',
  'machine learning',
  'deep learning',
  '神经网络',
  'transformer',
  '微调',
  'fine-tune',
  'finetune',
  '推理',
  '训练',
  'pytorch',
  'tensorflow',
  'huggingface',
  'langchain',
  '向量',
  'embedding',
  '多模态',
  'agi',
  '人工智能',
  'mcp',
  'token',
  'api',
  'sdk',
  'github',
  '论文',
  'arxiv',
];

/**
 * 明显与人设无关的话题模式（命中且未命中 RELEVANT 时跳过）。
 * 覆盖娱乐八卦、游戏、美食、穿搭、生活等常见非技术类话题。
 */
export const IRRELEVANT_PATTERNS: RegExp[] = [
  // 娱乐 / 明星 / 八卦
  /明星|爱豆|偶像|追星|八卦|绯闻|恋情|塌房|顶流/i,
  /综艺|选秀|出道|打歌|演唱会|粉丝见面会/i,
  /电视剧|追剧|剧荒|男主|女主|磕糖|嗑cp/i,
  // 游戏
  /游戏|手游|端游|开黑|王者荣耀|原神|绝区零|蛋仔|和平精英|永劫无间|英雄联盟|lol|steam|switch|塞尔达|宝可梦/i,
  // 美食 / 探店
  /美食|探店|奶茶|咖啡|甜品|蛋糕|火锅|烧烤|food|食谱|菜谱|减脂餐|早餐|brunch|下午茶/i,
  // 穿搭 / 美妆 / 时尚
  /穿搭|ootd|美妆|化妆|口红|护肤|彩妆|发型|穿衣|时尚|衣橱|包包|球鞋|首饰/i,
  // 旅行 / 生活
  /旅行|旅游|攻略|打卡|民宿|露营|徒步|周边游|citywalk/i,
  /减肥|健身|瑜伽|塑形|身材|马甲线|增肌/i,
  /情感|恋爱|分手|相亲|脱单|前任|挽回|闺蜜/i,
  // 家居 / 母婴 / 宠物
  /家居|装修|收纳|好物|开箱|平价|测评|种草/i,
  /母婴|育儿|宝宝|带娃|孕期|辅食/i,
  /宠物|猫咪|狗狗|铲屎官|养猫|养狗|布偶|柯基/i,
  // 星座 / 占卜
  /星座|占卜|塔罗|运势|水逆|本命年/i,
];

/** 预筛结果 */
export interface CardFilterResult {
  /** 是否打开 modal（true=打开，false=跳过） */
  open: boolean;
  /** 跳过原因（open=false 时给出，用于日志） */
  reason?: string;
}

/** 标题是否命中任一相关关键词 */
function hitsRelevant(title: string): boolean {
  const t = title.toLowerCase();
  return RELEVANT_KEYWORDS.some((kw) => t.includes(kw.toLowerCase()));
}

/** 标题是否命中任一无关模式 */
function hitsIrrelevant(title: string): boolean {
  return IRRELEVANT_PATTERNS.some((re) => re.test(title));
}

/**
 * 卡片预筛：在打开 modal 前用标题 / likes 快速判断是否值得打开。
 *
 * 规则（保守，宁可误放不可误杀）：
 *  1. likes 存在且解析后 < MIN_LIKES → 跳过；
 *  2. 标题存在且命中 IRRELEVANT_PATTERNS 且未命中 RELEVANT_KEYWORDS → 跳过；
 *  3. 其余（含无标题、无法判定）→ 打开。
 */
export function shouldOpenCard(card: NoteCard): CardFilterResult {
  // 1. likes 预筛
  if (card.likes) {
    const n = parseCount(card.likes);
    if (n < MIN_LIKES) {
      return { open: false, reason: `likes=${n}` };
    }
  }

  // 2. 标题相关性预筛
  const title = card.title?.trim();
  if (title) {
    if (hitsIrrelevant(title) && !hitsRelevant(title)) {
      return { open: false, reason: title };
    }
  }

  // 3. 无法判定 → 放行
  return { open: true };
}
