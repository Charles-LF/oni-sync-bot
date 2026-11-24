/** AI 运营面板前端类型（与服务端 `interface/aiInsightsConsole.ts` 的事件负载一致） */

/** AI 实际执行的一次工具调用 */
export interface AiChatToolCall {
  name: string;
  /** 传给工具的专有名词，如「电解器」 */
  keyword?: string;
  /** 实际命中的页面标题 */
  page?: string;
  [key: string]: unknown;
}

/** 列表行：只有回答摘要，完整回答走详情接口 */
export interface AiChatLogSummary {
  id: number;
  userId: string;
  userName: string;
  question: string;
  answerSummary: string;
  toolCalls: AiChatToolCall[];
  /** 毫秒时间戳 */
  createdAt: number;
}

export interface AiChatLogDetail extends Omit<AiChatLogSummary, "answerSummary"> {
  answer: string;
}

export interface AiChatLogPage {
  entries: AiChatLogSummary[];
  /** 命中搜索条件的条数 */
  total: number;
  /** 表内总条数 */
  totalAll: number;
}

export interface AiStats {
  totalUsers: number;
  totalQuestions: number;
  toolCallCount: number;
  topQuestions: Array<{ question: string; count: number }>;
  topKeywords: Array<{ keyword: string; count: number }>;
  /** 最近 7 天（北京时间切日） */
  dailyTrend: Array<{ date: string; count: number }>;
}

export const EMPTY_STATS: AiStats = {
  totalUsers: 0,
  totalQuestions: 0,
  toolCallCount: 0,
  topQuestions: [],
  topKeywords: [],
  dailyTrend: [],
};
