import { Context } from "koishi";
import type {
  SyncItemEvent,
  SyncLogLevel,
  SyncReporter,
} from "../../domain/sync/ports";
import {
  SyncRunRepository,
  type SyncRunFinish,
  type SyncRunItemDraft,
  type SyncRunLogDraft,
} from "../persistence/syncRunRepository";
import { getErrorMessage, logger } from "../../utils/tools";

/** 推给网页的实时日志（`sync/log` 广播） */
export interface SyncLogEvent {
  runId: string;
  taskId: string;
  level: SyncLogLevel;
  message: string;
  at: number;
  seq: number;
}

export interface SyncRunRecorderOptions {
  /** 单次运行最多保留的日志条数 */
  logLimit: number;
  /** 最多保留多少次运行 */
  runKeep: number;
  /** 实时推送；控制台未就绪时可以不传 */
  broadcast?: (event: SyncLogEvent) => void;
  /** 落库节流间隔（毫秒） */
  flushDelay?: number;
}

/** 单条日志/原因的最大长度，避免异常堆栈把整张表撑爆 */
const MAX_MESSAGE_LENGTH = 1000;

/**
 * 一次同步运行的记录器（端口 `SyncReporter` 的实现）。
 *
 * - 日志与条目先入内存缓冲，按 `flushDelay` 合并写库，避免每条日志一次 IO；
 * - 日志同时通过 `sync/log` 实时广播，网页端不用等落库就能滚动查看；
 * - `finish()` 负责写最终状态并按保留策略裁剪。
 */
export class SyncRunRecorder implements SyncReporter {
  private pendingLogs: SyncRunLogDraft[] = [];
  private pendingItems: SyncRunItemDraft[] = [];
  private timer?: () => void;
  private seq = 0;
  private closed = false;

  constructor(
    private readonly ctx: Context,
    private readonly repo: SyncRunRepository,
    readonly runId: string,
    readonly taskId: string,
    private readonly options: SyncRunRecorderOptions,
  ) {}

  log(level: SyncLogLevel, message: string): void {
    if (this.closed) return;
    const text = clip(message);
    const at = Date.now();
    this.pendingLogs.push({ seq: this.nextSeq(), level, message: text, at });
    this.options.broadcast?.({
      runId: this.runId,
      taskId: this.taskId,
      level,
      message: text,
      at,
      seq: this.seq,
    });
    this.schedule();
  }

  item(event: SyncItemEvent): void {
    if (this.closed) return;
    this.pendingItems.push({
      seq: this.nextSeq(),
      title: clip(event.title, 200),
      action: event.action,
      reason: clip(event.message || event.reason),
      at: event.at,
    });
    this.schedule();
  }

  /** 把缓冲区写库；重复调用安全（空的直接返回） */
  async flush(): Promise<void> {
    this.cancelTimer();
    const logs = this.pendingLogs;
    const items = this.pendingItems;
    this.pendingLogs = [];
    this.pendingItems = [];

    try {
      await this.repo.appendLogs(this.runId, logs);
      await this.repo.appendItems(this.runId, items);
    } catch (error) {
      logger.warn(
        `[同步任务] 写入运行日志失败（不影响同步本身）：${getErrorMessage(error)}`,
      );
    }
  }

  /** 收尾：刷盘 → 写最终状态 → 按保留策略裁剪 */
  async finish(patch: SyncRunFinish): Promise<void> {
    this.closed = true;
    this.cancelTimer();
    await this.flush();

    try {
      await this.repo.finish(this.runId, patch);
      await this.repo.trimLogs(this.runId, this.options.logLimit);
      await this.repo.trimRuns(this.options.runKeep);
    } catch (error) {
      logger.warn(
        `[同步任务] 保存运行结果失败：${getErrorMessage(error)}`,
      );
    }
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    const delay = this.options.flushDelay ?? 400;
    // 单测 / 无计时器的环境直接放弃节流，交由调用方 flush()
    if (typeof this.ctx.setTimeout !== "function") return;
    this.timer = this.ctx.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    try {
      this.timer();
    } catch {
      // disposer 重复调用无副作用，忽略即可
    }
    this.timer = undefined;
  }
}

function clip(text: string, max = MAX_MESSAGE_LENGTH): string {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
