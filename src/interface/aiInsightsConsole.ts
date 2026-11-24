import { Context } from "koishi";
import type { AiConfig } from "../config";
import {
  AiChatLogUseCase,
  type AiChatLogDetail,
  type AiChatLogDraft,
  type AiChatLogPage,
  type AiChatLogQuery,
  type AiChatLogSummary,
} from "../application/ai/aiChatLogUseCase";
import type { AiStats } from "../domain/ai/chatLog";
import { AiChatLogRepository } from "../infrastructure/persistence/aiChatLogRepository";
import { getErrorMessage, logger } from "../utils/tools";

declare module "koishi" {
  interface Context {
    /** AI 运营面板服务（见 interface/aiInsightsConsole.ts） */
    aiInsights: AiInsightsConsole;
  }
}

declare module "@koishijs/console" {
  interface Events {
    /** 分页获取最近对话（按用户名 / QQ 号 / 问题搜索） */
    "get-ai-logs"(payload?: AiChatLogQuery): Promise<AiChatLogPage>;
    /** 看板统计：总人数 / 总提问 / Top 问题 / 7 日趋势 … */
    "get-ai-stats"(): Promise<AiStats>;
    /** 单条详情（完整 AI 回答） */
    "ai/get-log"(payload: { id: number }): Promise<AiChatLogDetail | null>;
    /** 广播：有新对话写入，前端据此刷新列表 */
    "ai/chat/new"(payload: AiChatLogSummary): void;
  }
}

export type AiInsightsConfig = Pick<AiConfig, "aiChatLogLimit">;

/**
 * AI 运营面板（接口层）。
 *
 * - `.ai` 问答已于 0.20.0 移除，这里只负责**读取**历史对话记录；
 * - 注册控制台事件 `get-ai-logs` / `get-ai-stats` / `ai/get-log`；
 * - `record()` 仍保留（写入接口 + `ai/chat/new` 广播），以后要接回问答或别的模型直接调它即可。
 *
 * 写入路径全部是 fire-and-forget：统计可以慢一拍，但不能阻塞调用方。
 */
export class AiInsightsConsole {
  public static readonly inject = {
    database: { required: true },
    console: { required: true },
  };

  private readonly repository: AiChatLogRepository;
  private readonly useCase: AiChatLogUseCase;

  constructor(
    private readonly ctx: Context,
    config: AiInsightsConfig,
  ) {
    this.repository = new AiChatLogRepository(ctx, {
      maxRows: config.aiChatLogLimit ?? 10000,
    });
    this.useCase = new AiChatLogUseCase(this.repository, (entry) =>
      this.broadcast(entry),
    );

    ctx.set("aiInsights", this);
    this.registerListeners(ctx);

    // 启动时校准总数并顺手裁掉超限历史（进程关停期间没有写入，不会误删新数据）
    void this.repository.trim().catch((error) => {
      logger.warn(`[AI 运营] 启动裁剪失败：${getErrorMessage(error)}`);
    });
  }

  /** 记录一轮问答；失败只打日志，不影响用户拿回答 */
  record(draft: AiChatLogDraft): void {
    void this.useCase.record(draft).catch((error) => {
      logger.warn(`[AI 运营] 写入对话记录失败：${getErrorMessage(error)}`);
    });
  }

  logs(query: AiChatLogQuery = {}): Promise<AiChatLogPage> {
    return this.useCase.list(query);
  }

  stats(): Promise<AiStats> {
    return this.useCase.stats();
  }

  async detail(id: number): Promise<AiChatLogDetail | null> {
    return (await this.useCase.get(id)) ?? null;
  }

  private broadcast(entry: AiChatLogSummary): void {
    try {
      void this.ctx
        .get("console")
        ?.broadcast("ai/chat/new", entry, { authority: 0 });
    } catch (error) {
      logger.debug(`[AI 运营] 广播新对话失败：${getErrorMessage(error)}`);
    }
  }

  private registerListeners(ctx: Context): void {
    ctx.console.addListener("get-ai-logs", (payload) => this.logs(payload), {
      authority: 0,
    });
    ctx.console.addListener("get-ai-stats", () => this.stats(), {
      authority: 0,
    });
    ctx.console.addListener("ai/get-log", (payload) => this.detail(payload.id), {
      authority: 0,
    });
  }
}
