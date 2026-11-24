/**
 * 回答的数值体检（领域层纯函数）。
 *
 * 打的是 AI 最常见的两类翻车：
 * 1. **同一个量前后不一致** —— 前面按 0.9% 算，下一段又写成 9%（差 10 倍）；
 * 2. **凭空补数** —— 资料里没有的数值被直接写进结论。
 *
 * 这里只做「要不要复核」的判定与提示词拼装，真正要不要改由模型按资料复核，
 * 所以逻辑必须是纯函数，方便单测（见 `tests/answerGuard.spec.ts`）。
 */

/** 回答里的一处百分比 */
export interface PercentHit {
  /** 数值，如 0.9 */
  value: number;
  /** 原文写法，如 `0.9%` */
  raw: string;
}

export interface NumericIssue {
  /** 给人看的问题描述，会直接塞进复核提示词 */
  message: string;
}

/** 复核结论是「没问题」时的约定回复 */
export const VERIFY_OK = "OK";

/** 「资料不足」类措辞：命中就认为这次回答可能漏查了 */
const INCOMPLETE_MARKERS = [
  "未提及",
  "无法计算",
  "无法得出",
  "无法确定",
  "无法推算",
  "资料不足",
  "资料中没有",
  "资料中未",
  "缺少",
];

/**
 * 这份回答是不是「查不动了」的收场白。
 *
 * 用在「模型只查了一两个词条就想收尾」的判定上：复合问题里出现这种措辞，
 * 十有八九是漏查了某个基础词条，值得再推它查一次而不是直接把「不知道」发出去。
 */
export function looksIncomplete(answer: string): boolean {
  const text = (answer ?? "").trim();
  if (!text) return true;
  return INCOMPLETE_MARKERS.some((marker) => text.includes(marker));
}

/** `0.9%` / `37.5 %` / `9%` */
const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*%/g;
/** 带单位的数值：`3.33 千克/秒`、`90 克/秒`、`240 瓦` */
const NUMBER_PATTERN = /\d+(?:\.\d+)?/g;

export function collectPercents(answer: string): PercentHit[] {
  const hits: PercentHit[] = [];
  for (const match of (answer ?? "").matchAll(PERCENT_PATTERN)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    hits.push({ value, raw: match[0] });
  }
  return hits;
}

/** 两份数值是否「差 10 倍」（浮点比较留 2% 容差） */
function isTenTimes(a: number, b: number): boolean {
  if (a <= 0 || b <= 0) return false;
  const ratio = Math.max(a, b) / Math.min(a, b);
  return ratio >= 9.8 && ratio <= 10.2;
}

/**
 * 找出回答里「同一份回答内相差 10 倍的百分比」。
 *
 * 这是 0.9% 写成 9% 这类错误的直接指纹：`90 克/秒 ÷ 10 千克/秒 = 0.9%`
 * 与「9% 变天然气」出现在同一段回答里，必然有一个是错的。
 * 两种百分比都合法地出现在同一回答里的情况极少（真要如此，复核也会判 OK）。
 */
export function detectPercentConflicts(answer: string): NumericIssue[] {
  const hits = collectPercents(answer);
  if (hits.length < 2) return [];

  const issues: NumericIssue[] = [];
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      if (!isTenTimes(hits[i].value, hits[j].value)) continue;
      const bigger = hits[i].value > hits[j].value ? hits[i] : hits[j];
      const smaller = bigger === hits[i] ? hits[j] : hits[i];
      issues.push({
        message:
          `同一个量出现了两个相差 10 倍的百分比：「${smaller.raw}」与「${bigger.raw}」。` +
          `如果它们描述的是同一件事（例如原油精炼器的天然气产率），其中必有一个算错了。`,
      });
    }
  }
  return issues;
}

/**
 * 这份回答需不需要「数值复核」。
 *
 * 只要出现百分比、等号算式，或 3 个以上数字，就认为它含有推导，
 * 值得多花一次便宜的调用核对（问答里最常见的幻觉都在这一步）。
 */
export function needsNumericCheck(answer: string): boolean {
  const text = answer ?? "";
  if (text.match(PERCENT_PATTERN)) return true;
  if (text.includes("=") || text.includes("＝")) return true;
  return (text.match(NUMBER_PATTERN)?.length ?? 0) >= 3;
}

/** 复核用的系统提示词：只核对数值，不改文风、不补内容 */
export const VERIFY_SYSTEM_PROMPT = [
  "你是一个严格的数值校对员。用户会给你三部分内容：原始问题、检索到的 BWIKI 资料原文、以及一份待校对回答。",
  "你的唯一任务：**核对回答里的每一个数值**。不要改写文风，不要补充资料里没有的内容。",
  "重点检查：",
  "1. 百分比换算是否写对：`90 克/秒 ÷ 10 千克/秒 = 0.9%`，写成 9% 是错的；",
  "2. 同一个量是否前后出现了两个不同的值（尤其是相差 10 倍的百分比）；",
  "3. 是否有资料里根本不存在的数值；",
  "4. 算式的结果与写出来的结论是否一致。",
  "**只判断数值与算式对错**：措辞、格式、详略、是否分点、语气好坏都不算问题。",
  "只要数值和算式都对，哪怕你认为可以写得更详细、更通顺，也必须输出 OK。",
  "输出格式（必须严格遵守，不要输出任何前言、解释或 Markdown 代码块）：",
  "- 若**没有任何**数值问题：整个回复只有一行 `OK`，不要复述回答；",
  "- 若发现问题：第一行只写 `FIX`，从第二行开始输出修正后的完整回答（保留原有结构与口吻，只改错的地方）；",
  "- 若关键数值在资料里根本没有、无法计算：第一行写 `FIX`，第二行起输出：抱歉，资料中未提及相关信息。",
].join("\n");

/** 复核请求的用户消息：问题 + 资料摘录 + 待校对回答（+ 已知疑点） */
export function buildVerifyMessage(
  question: string,
  sources: string,
  answer: string,
  hints: readonly string[] = [],
  maxSourceChars = 6000,
): string {
  const excerpt =
    sources.length > maxSourceChars
      ? `${sources.slice(0, maxSourceChars)}\n（资料过长，已截断）`
      : sources;
  const parts = [
    `【原始问题】${question}`,
    `【检索到的资料】\n${excerpt}`,
    `【待校对回答】\n${answer}`,
  ];
  if (hints.length > 0) {
    parts.push(`【程序预检发现的疑点】\n${hints.map((hint) => `- ${hint}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** 复核回复是否表示「没问题」 */
export function isVerifyOk(reply: string): boolean {
  const text = (reply ?? "").trim();
  if (!text) return false;
  return text.toUpperCase().startsWith(VERIFY_OK);
}

/** 复核回复短到这个程度基本不是完整回答，视为无效、沿用原稿 */
const MIN_REVISION_LENGTH = 30;

/** 复核结论 */
export interface VerifyVerdict {
  /** true = 原稿没问题，保持不动 */
  ok: boolean;
  /** ok 为 false 时给出的修正稿 */
  revision?: string;
}

/**
 * 解析复核回复。
 *
 * 协议是「`OK` 或 `FIX` + 换行 + 修正稿」。**没有协议头就一律沿用原稿**：
 * 模型有时会直接把回答复述一遍，那种输出既不是修正也不该覆盖原稿。
 */
export function parseVerifyReply(reply: string): VerifyVerdict {
  const text = (reply ?? "").trim();
  if (!text) return { ok: true };

  const lines = text.split("\n");
  const head = lines[0].trim().toUpperCase();
  if (head === VERIFY_OK || head.startsWith(`${VERIFY_OK} `) || head.startsWith(`${VERIFY_OK}，`)) {
    return { ok: true };
  }

  const body = lines.slice(1).join("\n").trim();
  if (head.startsWith("FIX")) {
    // 说了要修却没给内容（或给得太短）：当没修，避免把回答换成半句话
    return body.length >= MIN_REVISION_LENGTH
      ? { ok: false, revision: body }
      : { ok: true };
  }

  return { ok: true };
}

/**
 * 回答里出现的所有数字（排序去重后的指纹）。
 *
 * 用来判断「这次修正到底改了数值没有」：只改措辞的修正没有意义，
 * 不值得把原稿换掉（换了反而可能丢内容或改坏口吻）。
 */
export function numericSignature(answer: string): string {
  const numbers = (answer ?? "").match(/\d+(?:\.\d+)?/g) ?? [];
  const normalized = numbers
    .map((raw) => String(Number(raw)))
    .filter((value) => value !== "NaN");
  return [...new Set(normalized)].sort().join(",");
}

/**
 * 决定用复核结果还是原稿。
 *
 * - 复核说 OK / 没按格式回 → 原稿；
 * - 复核按格式给了 `FIX` 且内容够长 → 修；
 * - 但若修正稿的数字与原稿完全一样（只是换了措辞） → 仍用原稿，
 *   因为这道闸门只负责数值，不负责文风。
 */
export function pickRevision(draft: string, reply: string): string {
  const verdict = parseVerifyReply(reply);
  if (verdict.ok || !verdict.revision) return draft;
  if (numericSignature(verdict.revision) === numericSignature(draft)) return draft;
  return verdict.revision;
}
