/**
 * AI 运营面板的领域类型与纯聚合逻辑。
 *
 * 这里不碰数据库 / Koishi：输入是一批「对话记录的精简投影」，
 * 输出是统计结果，方便单测（见 `tests/aiInsights.spec.ts`）。
 */

/** AI 实际执行的一次工具调用（目前只有 search_oni_bwiki） */
export interface AiChatToolCall {
  name: string;
  /** 传给工具的专有名词，如「电解器」 */
  keyword?: string;
  /** 实际命中的页面标题（没查到就没有） */
  page?: string;
  [key: string]: unknown;
}

/** 统计只需要这些列，避免把 answer 正文读进内存 */
export interface AiStatsRow {
  userId: string;
  question: string;
  toolCalls: AiChatToolCall[];
  /** 毫秒时间戳 */
  createdAt: number;
}

export interface AiStats {
  /** 提问过的总人数（按 userId 去重） */
  totalUsers: number;
  /** 总提问数 */
  totalQuestions: number;
  /** 工具调用总次数 */
  toolCallCount: number;
  /** 高频问题 Top N（归一化后分组） */
  topQuestions: Array<{ question: string; count: number }>;
  /** 高频专有名词 Top N（来自工具调用的 keyword） */
  topKeywords: Array<{ keyword: string; count: number }>;
  /** 最近 7 天提问量（按北京时间切日） */
  dailyTrend: Array<{ date: string; count: number }>;
}

export const TREND_DAYS = 7;
export const TOP_QUESTION_LIMIT = 10;
export const TOP_KEYWORD_LIMIT = 5;
/** 列表里的「AI 回答摘要」长度 */
export const ANSWER_SUMMARY_LENGTH = 120;

const BEIJING_OFFSET = 8 * 3600_000;
const DAY = 86_400_000;

export function summarizeAnswer(
  answer: string,
  max = ANSWER_SUMMARY_LENGTH,
): string {
  const text = (answer ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** 高频问题分组用的归一化：去掉空白 / 标点 / 符号，忽略大小写 */
export function normalizeQuestion(question: string): string {
  return (question ?? "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 北京时间下的「第几天」，用它分桶可以避免服务器时区影响 */
function dayIndexOf(time: number): number {
  return Math.floor((time + BEIJING_OFFSET) / DAY);
}

function dayLabel(dayIndex: number): string {
  const date = new Date(dayIndex * DAY);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** 把一批记录聚合成看板需要的全部指标（O(n) 单趟） */
export function buildAiStats(
  rows: readonly AiStatsRow[],
  now = Date.now(),
): AiStats {
  const users = new Set<string>();
  const questions = new Map<string, { question: string; count: number }>();
  const keywords = new Map<string, number>();
  let toolCallCount = 0;

  const today = dayIndexOf(now);
  const trend = new Map<number, number>();
  for (let offset = TREND_DAYS - 1; offset >= 0; offset--) {
    trend.set(today - offset, 0);
  }

  for (const row of rows) {
    if (row.userId) users.add(row.userId);

    const key = normalizeQuestion(row.question);
    if (key) {
      const entry = questions.get(key);
      if (entry) entry.count += 1;
      else {
        questions.set(key, {
          question: (row.question ?? "").trim(),
          count: 1,
        });
      }
    }

    for (const call of row.toolCalls ?? []) {
      toolCallCount += 1;
      const keyword = call?.keyword?.trim();
      if (!keyword) continue;
      keywords.set(keyword, (keywords.get(keyword) ?? 0) + 1);
    }

    const day = dayIndexOf(row.createdAt);
    if (trend.has(day)) trend.set(day, (trend.get(day) ?? 0) + 1);
  }

  const topQuestions = [...questions.values()]
    .sort((a, b) => b.count - a.count || a.question.localeCompare(b.question))
    .slice(0, TOP_QUESTION_LIMIT);

  const topKeywords = [...keywords.entries()]
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword))
    .slice(0, TOP_KEYWORD_LIMIT);

  const dailyTrend = [...trend.entries()].map(([day, count]) => ({
    date: dayLabel(day),
    count,
  }));

  return {
    totalUsers: users.size,
    totalQuestions: rows.length,
    toolCallCount,
    topQuestions,
    topKeywords,
    dailyTrend,
  };
}
