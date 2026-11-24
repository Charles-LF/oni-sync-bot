import {
  buildAiStats,
  summarizeAnswer,
  type AiChatToolCall,
  type AiStats,
  type AiStatsRow,
} from "../../domain/ai/chatLog";

/**
 * AI 对话日志用例（应用层）。
 *
 * 对外只暴露四个动作：记录一轮问答、分页查询、取详情、聚合统计。
 * 仓储细节在 `infrastructure/persistence/aiChatLogRepository.ts`。
 */

export interface AiChatLogDraft {
  userId: string;
  userName: string;
  question: string;
  answer: string;
  toolCalls: AiChatToolCall[];
  /** 缺省为当前时间（毫秒） */
  createdAt?: number;
}

/** 列表行：answer 只给摘要，完整回答走详情接口 */
export interface AiChatLogSummary {
  id: number;
  userId: string;
  userName: string;
  question: string;
  answerSummary: string;
  toolCalls: AiChatToolCall[];
  createdAt: number;
}

export interface AiChatLogDetail extends Omit<AiChatLogSummary, "answerSummary"> {
  answer: string;
}

export interface AiChatLogQuery {
  offset?: number;
  limit?: number;
  /** 按用户名 / QQ 号 / 问题内容模糊搜索 */
  keyword?: string;
}

export interface AiChatLogPage {
  entries: AiChatLogSummary[];
  /** 命中关键词的条数 */
  total: number;
  /** 表里的总条数 */
  totalAll: number;
}

/** 仓储端口：接口层只依赖这个形状 */
export interface AiChatLogStore {
  append(draft: Required<AiChatLogDraft>): Promise<number>;
  list(query: AiChatLogQuery): Promise<AiChatLogPage>;
  get(id: number): Promise<AiChatLogDetail | undefined>;
  listForStats(): Promise<AiStatsRow[]>;
  count(): Promise<number>;
}

export class AiChatLogUseCase {
  constructor(
    private readonly store: AiChatLogStore,
    /** 落库成功后的回调（控制台用来广播 `ai/chat/new`） */
    private readonly onRecorded?: (entry: AiChatLogSummary) => void,
  ) {}

  /**
   * 记录一轮问答。
   *
   * 调用方 `void` 掉即可：这里是**纯观测**，写失败不能影响用户拿回答。
   */
  async record(draft: AiChatLogDraft): Promise<AiChatLogSummary | undefined> {
    const question = (draft.question ?? "").trim();
    if (!question) return undefined;

    const normalized: Required<AiChatLogDraft> = {
      userId: draft.userId ?? "",
      userName: draft.userName ?? "",
      question,
      answer: draft.answer ?? "",
      toolCalls: draft.toolCalls ?? [],
      createdAt: draft.createdAt ?? Date.now(),
    };

    const id = await this.store.append(normalized);
    const summary: AiChatLogSummary = {
      id,
      userId: normalized.userId,
      userName: normalized.userName,
      question: normalized.question,
      answerSummary: summarizeAnswer(normalized.answer),
      toolCalls: normalized.toolCalls,
      createdAt: normalized.createdAt,
    };

    try {
      this.onRecorded?.(summary);
    } catch {
      // 广播失败不影响落库
    }
    return summary;
  }

  list(query: AiChatLogQuery = {}): Promise<AiChatLogPage> {
    return this.store.list(query);
  }

  get(id: number): Promise<AiChatLogDetail | undefined> {
    return this.store.get(id);
  }

  async stats(): Promise<AiStats> {
    return buildAiStats(await this.store.listForStats());
  }

  count(): Promise<number> {
    return this.store.count();
  }
}
