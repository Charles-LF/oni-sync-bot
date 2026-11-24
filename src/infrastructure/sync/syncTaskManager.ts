import { Context } from "koishi";
import { RunToken, SyncAbortedError } from "../../domain/sync/runToken";
import type { SyncLogLevel } from "../../domain/sync/ports";
import {
  emptyProgress,
  type ControlResult,
  type ProgressReporter,
  type SyncPanelSnapshot,
  type SyncProgress,
  type SyncRunSummary,
  type SyncRunner,
  type SyncTaskId,
  type SyncTaskMeta,
  type SyncTaskState,
} from "../../application/sync/syncTypes";
import { getErrorMessage, logger } from "../../utils/tools";

/**
 * 多任务同步管理器（基础设施层）。
 *
 * 状态/进度类型定义在应用层（`application/sync/syncTypes.ts`），取消令牌在领域层
 * （`domain/sync/runToken.ts`）；这里只负责运行期调度与状态机。
 */
export * from "../../application/sync/syncTypes";
export { RunToken, SyncAbortedError } from "../../domain/sync/runToken";

/** 状态变更立即推送，进度变更节流推送 */
const PROGRESS_NOTIFY_DELAY = 400;

/** 任务生命周期日志的出口（控制台把它接到 `sync/log` 广播上） */
export type TaskLogSink = (
  taskId: SyncTaskId,
  level: SyncLogLevel,
  message: string,
) => void;

interface TaskRuntime extends SyncTaskMeta {
  state: SyncTaskState;
  progress: SyncProgress;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
  lastSummary?: string;
  lastTrigger?: string;
  token?: RunToken;
  stopping: boolean;
}

/**
 * 多任务同步管理器。
 *
 * - 每个任务（增量 / 全量页面 / 全量图片 / 全量模块）有自己的状态与进度
 * - **同一时刻只允许一个任务真正执行**：2C2G 的机器上并发同步只会互相拖慢
 * - `controllable=false` 的任务（增量同步）只接受代码内部触发
 */
export class SyncTaskManager {
  private readonly runtimes = new Map<SyncTaskId, TaskRuntime>();
  private version = 0;
  private notifyTimer?: () => void;

  constructor(
    private readonly ctx: Context,
    metas: SyncTaskMeta[],
    private readonly onChange: (snapshot: SyncPanelSnapshot) => void,
    /** 生命周期日志出口；不传则只写 debug 日志 */
    private readonly onLog?: TaskLogSink,
  ) {
    for (const meta of metas) {
      this.runtimes.set(meta.id, {
        ...meta,
        state: "idle",
        progress: emptyProgress(),
        stopping: false,
      });
    }
  }

  /** 正在执行或暂停中的任务 */
  get activeId(): SyncTaskId | undefined {
    for (const runtime of this.runtimes.values()) {
      if (runtime.state === "running" || runtime.state === "paused") {
        return runtime.id;
      }
    }
    return undefined;
  }

  get busy(): boolean {
    return this.activeId !== undefined;
  }

  snapshot(): SyncPanelSnapshot {
    return {
      tasks: [...this.runtimes.values()].map((runtime) => ({
        id: runtime.id,
        label: runtime.label,
        description: runtime.description,
        controllable: runtime.controllable,
        // 「正在停止」对前端就是 stopped，避免用户以为还能继续
        state: runtime.stopping ? "stopped" : runtime.state,
        progress: { ...runtime.progress },
        startedAt: runtime.startedAt,
        finishedAt: runtime.finishedAt,
        lastError: runtime.lastError,
        lastSummary: runtime.lastSummary,
        lastTrigger: runtime.lastTrigger,
      })),
      activeId: this.activeId,
      version: this.version,
    };
  }

  /**
   * 启动任务。
   *
   * 同一时刻只允许一个任务执行，冲突时按优先级让路：
   * - 增量同步优先级最高：它要跑时，正在跑的全量任务会被**自动暂停**
   * - 全量任务之间互相让路：新启动的接手，旧任务自动暂停（可再「继续」）
   * - 增量同步在跑时，全量任务直接拒绝（不能抢占自动任务）
   *
   * @param manual 来自控制台/命令的行为 true：不可控任务会被直接拒绝
   */
  async start(
    id: SyncTaskId,
    trigger: string,
    runner: SyncRunner,
    manual = false,
  ): Promise<ControlResult> {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      return { ok: false, message: `未知任务：${id}`, status: this.snapshot() };
    }
    if (manual && !runtime.controllable) {
      return {
        ok: false,
        message: `${runtime.label}由代码自动调度，不支持手动启动`,
        status: this.snapshot(),
      };
    }

    // 已暂停的同一个任务，点「开始」直接续跑
    if (runtime.state === "paused") {
      return this.resume(id);
    }
    if (runtime.state === "running") {
      return {
        ok: false,
        message: `${runtime.label}已在运行`,
        status: this.snapshot(),
      };
    }

    let yielded = "";
    const active = this.activeId;
    if (active && active !== id) {
      const busy = this.runtimes.get(active)!;
      if (!busy.controllable) {
        // 增量同步优先级最高，全量任务不能抢占
        return {
          ok: false,
          message: `「${busy.label}」正在运行（优先级最高），请稍后再试`,
          status: this.snapshot(),
        };
      }
      busy.token?.pause();
      busy.state = "paused";
      busy.progress.message = `因启动「${runtime.label}」而自动暂停，可稍后继续`;
      yielded = busy.label;
      this.log(busy.id, "info", `「${busy.label}」让路给「${runtime.label}」`);    }

    const token = new RunToken();
    runtime.token = token;
    runtime.state = "running";
    runtime.stopping = false;
    runtime.progress = {
      ...emptyProgress(),
      phase: "准备",
      message: "任务已启动",
    };
    runtime.startedAt = Date.now();
    runtime.finishedAt = undefined;
    runtime.lastError = undefined;
    runtime.lastTrigger = trigger;
    this.publish(true);

    this.log(
      runtime.id,
      "info",
      `已启动「${runtime.label}」（触发方式：${trigger}）`,
    );
    void this.execute(runtime, token, runner);
    return {
      ok: true,
      message: yielded
        ? `已暂停「${yielded}」，开始${runtime.label}`
        : `${runtime.label}已启动`,
      status: this.snapshot(),
    };
  }

  private async execute(
    runtime: TaskRuntime,
    token: RunToken,
    runner: SyncRunner,
  ): Promise<void> {
    try {
      const summary = await runner(token, (patch) =>
        this.report(runtime, patch),
      );
      runtime.lastSummary = summary.message;
      runtime.progress = {
        ...runtime.progress,
        current: runtime.progress.total || runtime.progress.current,
        message: summary.message,
      };
      runtime.state = "idle";
      this.log(runtime.id, "info", `「${runtime.label}」完成：${summary.message}`);
    } catch (error) {
      if (error instanceof SyncAbortedError) {
        runtime.state = "stopped";
        const { current, total } = runtime.progress;
        const detail =
          runtime.progress.message &&
          !runtime.progress.message.startsWith("正在停止")
            ? ` · ${runtime.progress.message}`
            : "";
        runtime.progress.message = `已停止（已处理 ${current}/${total || "?"}）${detail}`;
        this.log(
          runtime.id,
          "warn",
          `「${runtime.label}」已停止（已处理 ${current}/${total || "?"}）`,
        );
      } else {
        runtime.state = "idle";
        runtime.lastError = getErrorMessage(error);
        this.log(
          runtime.id,
          "error",
          `「${runtime.label}」失败：${runtime.lastError}`,
        );
      }
    } finally {
      runtime.stopping = false;
      runtime.token = undefined;
      runtime.finishedAt = Date.now();
      this.publish(true);
    }
  }

  pause(id: SyncTaskId): ControlResult {
    const runtime = this.checkControllable(id, "暂停");
    if ("message" in runtime) return runtime;
    if (runtime.state !== "running") {
      return {
        ok: false,
        message:
          runtime.state === "paused" ? "任务已处于暂停状态" : "当前没有运行中的任务",
        status: this.snapshot(),
      };
    }
    runtime.token?.pause();
    runtime.state = "paused";
    runtime.progress.message = "已暂停，点击「继续」恢复";
    this.publish(true);
    this.log(runtime.id, "info", `「${runtime.label}」已暂停`);
    return { ok: true, message: "已暂停", status: this.snapshot() };
  }

  resume(id: SyncTaskId): ControlResult {
    const runtime = this.checkControllable(id, "继续");
    if ("message" in runtime) return runtime;
    if (runtime.state !== "paused") {
      return {
        ok: false,
        message: "当前没有暂停中的任务",
        status: this.snapshot(),
      };
    }
    runtime.token?.resume();
    runtime.state = "running";
    runtime.progress.message = "已继续";
    this.publish(true);
    this.log(runtime.id, "info", `「${runtime.label}」已继续`);
    return { ok: true, message: "已继续", status: this.snapshot() };
  }

  stop(id: SyncTaskId): ControlResult {
    const runtime = this.checkControllable(id, "停止");
    if ("message" in runtime) return runtime;
    if (runtime.state !== "running" && runtime.state !== "paused") {
      return {
        ok: false,
        message: "当前没有运行中的任务",
        status: this.snapshot(),
      };
    }
    runtime.stopping = true;
    runtime.token?.abort();
    runtime.progress.message = "正在停止…（等待当前请求结束）";
    this.publish(true);
    this.log(runtime.id, "info", `「${runtime.label}」收到停止请求`);
    return { ok: true, message: "正在停止", status: this.snapshot() };
  }

  /** 校验任务存在且可控；不可控时直接返回失败结果 */
  private checkControllable(
    id: SyncTaskId,
    action: string,
  ): TaskRuntime | ControlResult {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      return { ok: false, message: `未知任务：${id}`, status: this.snapshot() };
    }
    if (!runtime.controllable) {
      return {
        ok: false,
        message: `${runtime.label}由代码自动调度，不支持${action}`,
        status: this.snapshot(),
      };
    }
    return runtime;
  }

  private report(runtime: TaskRuntime, patch: Partial<SyncProgress>): void {
    runtime.progress = { ...runtime.progress, ...patch };
    this.publish(false);
  }

  /** 生命周期日志：交给控制台广播，服务端只留 debug */
  private log(id: SyncTaskId, level: SyncLogLevel, message: string): void {
    this.onLog?.(id, level, message);
    logger.debug(`[同步任务] ${message}`);
  }

  private publish(force: boolean): void {
    if (force) {
      if (this.notifyTimer) {
        this.notifyTimer();
        this.notifyTimer = undefined;
      }
      this.version++;
      this.onChange(this.snapshot());
      return;
    }
    if (this.notifyTimer) return;
    this.notifyTimer = this.ctx.setTimeout(() => {
      this.notifyTimer = undefined;
      this.version++;
      this.onChange(this.snapshot());
    }, PROGRESS_NOTIFY_DELAY);
  }
}
