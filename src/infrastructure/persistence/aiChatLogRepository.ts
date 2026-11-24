import { Context } from "koishi";
import type {
  AiChatLogDetail,
  AiChatLogPage,
  AiChatLogQuery,
  AiChatLogStore,
  AiChatLogSummary,
  AiChatLogDraft,
} from "../../application/ai/aiChatLogUseCase";
import { summarizeAnswer, type AiStatsRow } from "../../domain/ai/chatLog";

/** 列表需要的列；`answer` 只在这一页的行上读取，用于生成摘要 */
const LIST_FIELDS = [
  "id",
  "userId",
  "userName",
  "question",
  "answer",
  "toolCalls",
  "createdAt",
] as const;

/** 搜索时先只取索引列，命中后再回表取详情，避免把 1w 条 answer 读进内存 */
const INDEX_FIELDS = ["id", "userId", "userName", "question"] as const;

const WRITE_CHUNK = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface AiChatLogRepositoryOptions {
  /** 表内最多保留多少条（默认 10000） */
  maxRows?: number;
}

/**
 * `ai_chat_logs` 的仓储实现（基础设施层）。
 *
 * 写入走「队列 + 内存计数」：
 * - `append()` 串行排队，避免并发插入把计数写乱；
 * - 总条数只在首次使用时全表数一次，之后靠自增/删除维护，超出上限就删最早的一批；
 * - 调用方 `void` 掉即可，不阻塞 AI 回答。
 */
export class AiChatLogRepository implements AiChatLogStore {
  private total?: number;
  /** 串行化写入，保证计数与裁剪不会互相踩踏 */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly maxRows: number;

  constructor(
    private readonly ctx: Context,
    options: AiChatLogRepositoryOptions = {},
  ) {
    this.maxRows = Math.max(100, Math.floor(options.maxRows ?? 10000));
  }

  append(draft: Required<AiChatLogDraft>): Promise<number> {
    const task = this.queue.then(() => this.doAppend(draft));
    // 失败不堵住后续写入
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async doAppend(draft: Required<AiChatLogDraft>): Promise<number> {
    const before = await this.ensureTotal();

    const created = await this.ctx.database.create("ai_chat_logs", {
      userId: draft.userId,
      userName: draft.userName,
      question: draft.question,
      answer: draft.answer,
      toolCalls: draft.toolCalls,
      createdAt: new Date(draft.createdAt),
    });

    this.total = before + 1;
    await this.trim();
    return created?.id ?? 0;
  }

  async list(query: AiChatLogQuery = {}): Promise<AiChatLogPage> {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    const offset = Math.max(0, query.offset ?? 0);
    const keyword = (query.keyword ?? "").trim().toLowerCase();
    const totalAll = await this.ensureTotal();

    if (!keyword) {
      const rows = await this.ctx.database.get("ai_chat_logs", {}, {
        fields: [...LIST_FIELDS],
        sort: { id: "desc" },
        limit,
        offset,
      });
      return {
        entries: rows.map((row) => toSummary(row)),
        total: totalAll,
        totalAll,
      };
    }

    const index = await this.ctx.database.get("ai_chat_logs", {}, [
      ...INDEX_FIELDS,
    ]);
    const matched = index
      .filter(
        (row) =>
          row.userName.toLowerCase().includes(keyword) ||
          row.userId.toLowerCase().includes(keyword) ||
          row.question.toLowerCase().includes(keyword),
      )
      .sort((a, b) => b.id - a.id);

    const pageIds = matched.slice(offset, offset + limit).map((row) => row.id);
    if (pageIds.length === 0) {
      return { entries: [], total: matched.length, totalAll };
    }

    const rows = await this.ctx.database.get("ai_chat_logs", {
      id: { $in: pageIds },
    }, [...LIST_FIELDS]);
    const byId = new Map(rows.map((row) => [row.id, row] as const));

    return {
      entries: pageIds
        .map((id) => byId.get(id))
        .filter((row): row is (typeof rows)[number] => Boolean(row))
        .map((row) => toSummary(row)),
      total: matched.length,
      totalAll,
    };
  }

  async get(id: number): Promise<AiChatLogDetail | undefined> {
    const rows = await this.ctx.database.get("ai_chat_logs", { id });
    const row = rows[0];
    if (!row) return undefined;
    return { ...toSummary(row), answer: row.answer ?? "" };
  }

  async listForStats(): Promise<AiStatsRow[]> {
    const rows = await this.ctx.database.get("ai_chat_logs", {}, [
      "userId",
      "question",
      "toolCalls",
      "createdAt",
    ]);
    return rows.map((row) => ({
      userId: row.userId ?? "",
      question: row.question ?? "",
      toolCalls: row.toolCalls ?? [],
      createdAt: toTime(row.createdAt),
    }));
  }

  /** 强制重新数一遍（统计接口 / 启动校准用） */
  async count(): Promise<number> {
    const rows = await this.ctx.database.get("ai_chat_logs", {}, ["id"]);
    this.total = rows.length;
    return this.total;
  }

  /**
   * 超过上限时删除最早的一批（id 自增，字典序即时间序）。
   * 每次插入后都会调用，但只有真的溢出才会发查询。
   */
  async trim(): Promise<number> {
    const total = await this.ensureTotal();
    const overflow = total - this.maxRows;
    if (overflow <= 0) return 0;

    const rows = await this.ctx.database.get("ai_chat_logs", {}, {
      fields: ["id"],
      sort: { id: "asc" },
      limit: overflow,
    });
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      this.total = total;
      return 0;
    }

    for (let index = 0; index < ids.length; index += WRITE_CHUNK) {
      await this.ctx.database.remove("ai_chat_logs", {
        id: { $in: ids.slice(index, index + WRITE_CHUNK) },
      });
    }

    this.total = total - ids.length;
    return ids.length;
  }

  private async ensureTotal(): Promise<number> {
    if (this.total === undefined) {
      const rows = await this.ctx.database.get("ai_chat_logs", {}, ["id"]);
      this.total = rows.length;
    }
    return this.total;
  }
}

interface ListedRow {
  id: number;
  userId: string;
  userName: string;
  question: string;
  answer: string;
  toolCalls: unknown;
  createdAt: unknown;
}

function toSummary(row: ListedRow): AiChatLogSummary {
  return {
    id: row.id,
    userId: row.userId ?? "",
    userName: row.userName ?? "",
    question: row.question ?? "",
    answerSummary: summarizeAnswer(row.answer ?? ""),
    toolCalls: Array.isArray(row.toolCalls) ? row.toolCalls : [],
    createdAt: toTime(row.createdAt),
  };
}

/** `timestamp` 类型正常情况下读出 Date；个别驱动/旧数据可能是数字或字符串 */
function toTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
