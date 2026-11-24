import { Context } from "koishi";
import type {
  SyncRunItemRow,
  SyncRunLogRow,
  SyncRunRow,
} from "../../plugins/databaseExtension";
import { getErrorMessage, logger } from "../../utils/tools";

/** 单条 SQL 的参数上限有限，写入按下标切片 */
const WRITE_CHUNK = 100;

export interface SyncRunLogDraft {
  seq: number;
  level: string;
  message: string;
  at: number;
}

export interface SyncRunItemDraft {
  seq: number;
  title: string;
  action: string;
  reason: string;
  at: number;
}

/** 一次运行的最终状态 */
export type SyncRunState = "running" | "completed" | "stopped" | "failed";

export interface SyncRunFinish {
  state: Exclude<SyncRunState, "running">;
  message: string;
  total?: number;
  synced?: number;
  skipped?: number;
  failed?: number;
}

/**
 * `sync_runs` / `sync_run_items` / `sync_run_logs` 的仓储（基础设施层）。
 *
 * 三张表一起管理：详情弹窗要的是「一次运行」的完整快照，
 * 拆成三个仓储只会让调用方自己拼装。
 */
export class SyncRunRepository {
  constructor(private readonly ctx: Context) {}

  static createId(taskId: string, at = Date.now()): string {
    return `${taskId}-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  async begin(taskId: string, trigger: string): Promise<string> {
    const id = SyncRunRepository.createId(taskId);
    const startedAt = Date.now();
    await this.ctx.database.create("sync_runs", {
      id,
      taskId,
      trigger,
      state: "running",
      startedAt,
      finishedAt: 0,
      message: "",
      total: 0,
      synced: 0,
      skipped: 0,
      failed: 0,
    });
    return id;
  }

  async finish(runId: string, patch: SyncRunFinish): Promise<void> {
    await this.ctx.database.set(
      "sync_runs",
      { id: runId },
      {
        state: patch.state,
        message: patch.message,
        finishedAt: Date.now(),
        total: patch.total ?? 0,
        synced: patch.synced ?? 0,
        skipped: patch.skipped ?? 0,
        failed: patch.failed ?? 0,
      },
    );
  }

  async appendLogs(runId: string, logs: SyncRunLogDraft[]): Promise<void> {
    if (logs.length === 0) return;
    const rows = logs.map((log) => ({
      id: `${runId}#${pad(log.seq)}`,
      runId,
      level: log.level,
      message: log.message,
      at: log.at,
    }));
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      await this.ctx.database.upsert("sync_run_logs", rows.slice(i, i + WRITE_CHUNK));
    }
  }

  async appendItems(runId: string, items: SyncRunItemDraft[]): Promise<void> {
    if (items.length === 0) return;
    const rows = items.map((item) => ({
      id: `${runId}#${pad(item.seq)}`,
      runId,
      title: item.title,
      action: item.action,
      reason: item.reason,
      at: item.at,
    }));
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      await this.ctx.database.upsert("sync_run_items", rows.slice(i, i + WRITE_CHUNK));
    }
  }

  async latestRun(taskId?: string): Promise<SyncRunRow | undefined> {
    const rows = await this.ctx.database.get(
      "sync_runs",
      taskId ? { taskId } : {},
      { sort: { startedAt: "desc" }, limit: 1 },
    );
    return rows[0];
  }

  async getRun(runId: string): Promise<SyncRunRow | undefined> {
    const rows = await this.ctx.database.get("sync_runs", { id: runId });
    return rows[0];
  }

  async listRuns(taskId?: string, limit = 20): Promise<SyncRunRow[]> {
    return this.ctx.database.get(
      "sync_runs",
      taskId ? { taskId } : {},
      { sort: { startedAt: "desc" }, limit },
    );
  }

  async listItems(runId: string, limit = 2000): Promise<SyncRunItemRow[]> {
    return this.ctx.database.get(
      "sync_run_items",
      { runId },
      { sort: { id: "asc" }, limit },
    );
  }

  async listLogs(runId: string, limit = 2000): Promise<SyncRunLogRow[]> {
    return this.ctx.database.get(
      "sync_run_logs",
      { runId },
      { sort: { id: "asc" }, limit },
    );
  }

  /** 超出保留条数时删掉最早的日志（id 字典序即写入顺序） */
  async trimLogs(runId: string, keep: number): Promise<number> {
    const limit = Math.max(1, Math.floor(keep));
    const rows = await this.ctx.database.get("sync_run_logs", { runId }, ["id"]);
    const overflow = rows.length - limit;
    if (overflow <= 0) return 0;

    const ids = rows
      .map((row) => row.id)
      .sort()
      .slice(0, overflow);
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      await this.ctx.database.remove("sync_run_logs", {
        id: { $in: ids.slice(i, i + WRITE_CHUNK) },
      });
    }
    return ids.length;
  }

  /** 只保留最近 N 次运行，连同条目与日志一起清理 */
  async trimRuns(keep: number): Promise<number> {
    const limit = Math.max(1, Math.floor(keep));
    const runs = await this.ctx.database.get("sync_runs", {}, [
      "id",
      "startedAt",
    ]);
    const overflow = runs.length - limit;
    if (overflow <= 0) return 0;

    const stale = runs
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(limit)
      .map((run) => run.id);

    for (const runId of stale) {
      await this.ctx.database.remove("sync_run_logs", { runId });
      await this.ctx.database.remove("sync_run_items", { runId });
      await this.ctx.database.remove("sync_runs", { id: runId });
    }
    return stale.length;
  }

  /** 进程重启后，上次遗留的 running 记录不可能再结束，标记为 stopped */
  async closeDanglingRuns(): Promise<void> {
    try {
      const result = await this.ctx.database.set(
        "sync_runs",
        { state: "running" },
        {
          state: "stopped",
          message: "进程重启，任务已中断",
          finishedAt: Date.now(),
        },
      );
      const affected = (result as { matched?: number } | undefined)?.matched;
      if (affected) {
        logger.info(`[同步任务] 已把 ${affected} 条中断的运行记录标记为 stopped`);
      }
    } catch (error) {
      logger.debug(`清理中断运行记录失败：${getErrorMessage(error)}`);
    }
  }
}

function pad(seq: number): string {
  return String(seq).padStart(7, "0");
}
