import { Context } from "koishi";
import { getErrorMessage, logger } from "../utils/tools";

/** 任务状态：paused 只表示「已暂停且仍在运行中」 */
export type SyncTaskState = "idle" | "running" | "paused" | "stopped";

export interface SyncProgress {
  /** 当前阶段名，如「拉取变更」「同步页面」「检查图片」 */
  phase: string;
  /** 当前阶段已处理条数 */
  current: number;
  /** 当前阶段总条数；0 表示未知 */
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  /** 给用户看的一句话进度 */
  message: string;
}

export interface SyncRunSummary {
  synced: number;
  skipped: number;
  failed: number;
  message: string;
}

export interface SyncTaskSnapshot {
  state: SyncTaskState;
  progress: SyncProgress;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
  lastSummary?: string;
  lastTrigger?: string;
  /** 每次状态或进度变化自增，前端据此判断是否需要重查 */
  version: number;
}

export class SyncAbortedError extends Error {
  constructor(message = "同步任务已停止") {
    super(message);
    this.name = "SyncAbortedError";
  }
}

/**
 * 协作式取消令牌。
 *
 * 只在**分片边界**（处理下一个页面 / 下一批图片之前）检查：
 * 进行中的那次 mwn 请求一定会跑完，前端点「停止」不会留下半截请求或卡死。
 */
export class RunToken {
  private stopped = false;
  private pausedFlag = false;
  private waiters: Array<() => void> = [];

  get paused(): boolean {
    return this.pausedFlag;
  }

  get aborted(): boolean {
    return this.stopped;
  }

  pause(): void {
    if (!this.stopped) this.pausedFlag = true;
  }

  resume(): void {
    this.pausedFlag = false;
    this.flush();
  }

  abort(): void {
    this.stopped = true;
    this.pausedFlag = false;
    this.flush();
  }

  /** 每个分片开始前调用：已停止则抛错，已暂停则原地等待 */
  async checkpoint(): Promise<void> {
    if (this.stopped) throw new SyncAbortedError();
    while (this.pausedFlag && !this.stopped) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.stopped) throw new SyncAbortedError();
  }

  private flush(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** 进度上报函数：传入要覆盖的字段 */
export type ProgressReporter = (patch: Partial<SyncProgress>) => void;

export type SyncRunner = (
  token: RunToken,
  report: ProgressReporter,
) => Promise<SyncRunSummary>;

export interface ControlResult {
  ok: boolean;
  message: string;
  status: SyncTaskSnapshot;
}

/** 状态变更立即推送，进度变更节流推送 */
const PROGRESS_NOTIFY_DELAY = 400;

function emptyProgress(): SyncProgress {
  return {
    phase: "空闲",
    current: 0,
    total: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    message: "",
  };
}

/**
 * 同步任务管理器：同一时刻只允许一个同步任务，支持暂停 / 继续 / 停止。
 *
 * 与底层同步逻辑解耦——它只认识一个 `SyncRunner` 工厂，
 * 不关心跑的是页面还是图片。
 */
export class SyncTaskManager {
  private state: SyncTaskState = "idle";
  private token?: RunToken;
  private progress: SyncProgress = emptyProgress();
  private startedAt?: number;
  private finishedAt?: number;
  private lastError?: string;
  private lastSummary?: string;
  private lastTrigger?: string;
  private stopping = false;
  private version = 0;
  private notifyTimer?: () => void;
  /** 每次任务结束自增，供外部（如 cron）判断是否需要推进水位 */
  private runSeq = 0;

  constructor(
    private readonly ctx: Context,
    private readonly onChange: (snapshot: SyncTaskSnapshot) => void,
  ) {}

  get busy(): boolean {
    return this.state === "running" || this.state === "paused";
  }

  get running(): boolean {
    return this.busy;
  }

  get lastRunId(): number {
    return this.runSeq;
  }

  snapshot(): SyncTaskSnapshot {
    return {
      // 「正在停止」对前端就是 stopped，避免用户以为还能继续
      state: this.stopping ? "stopped" : this.state,
      progress: { ...this.progress },
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      lastError: this.lastError,
      lastSummary: this.lastSummary,
      lastTrigger: this.lastTrigger,
      version: this.version,
    };
  }

  async start(trigger: string, runner: SyncRunner): Promise<ControlResult> {
    if (this.busy) {
      return {
        ok: false,
        message: "已有同步任务在运行，请先停止或等待完成",
        status: this.snapshot(),
      };
    }

    const token = new RunToken();
    this.token = token;
    this.state = "running";
    this.stopping = false;
    this.progress = emptyProgress();
    this.progress.phase = "准备";
    this.progress.message = "任务已启动";
    this.startedAt = Date.now();
    this.finishedAt = undefined;
    this.lastError = undefined;
    this.lastTrigger = trigger;
    this.publish(true);

    logger.info(`[同步任务] 已启动（触发方式：${trigger}）`);
    void this.execute(token, runner);
    return { ok: true, message: "同步任务已启动", status: this.snapshot() };
  }

  private async execute(token: RunToken, runner: SyncRunner): Promise<void> {
    try {
      const summary = await runner(token, (patch) => this.report(patch));
      this.lastSummary = summary.message;
      this.progress = {
        ...this.progress,
        current: this.progress.total || this.progress.current,
        message: summary.message,
      };
      this.state = "idle";
      logger.info(`[同步任务] 完成：${summary.message}`);
    } catch (error) {
      if (error instanceof SyncAbortedError) {
        this.state = "stopped";
        this.progress.message = this.progress.message
          ? `已停止：${this.progress.message}`
          : "已停止";
        logger.warn(
          `[同步任务] 已停止（已处理 ${this.progress.current}/${this.progress.total || "?"}）`,
        );
      } else {
        this.state = "idle";
        this.lastError = getErrorMessage(error);
        logger.error(`[同步任务] 失败：${this.lastError}`);
      }
    } finally {
      this.stopping = false;
      this.token = undefined;
      this.finishedAt = Date.now();
      this.runSeq++;
      this.publish(true);
    }
  }

  pause(): ControlResult {
    if (this.state !== "running") {
      return {
        ok: false,
        message: this.state === "paused" ? "任务已处于暂停状态" : "当前没有运行中的任务",
        status: this.snapshot(),
      };
    }
    this.token?.pause();
    this.state = "paused";
    this.progress.message = "已暂停，点击「继续」恢复";
    this.publish(true);
    logger.info("[同步任务] 已暂停");
    return { ok: true, message: "已暂停", status: this.snapshot() };
  }

  resume(): ControlResult {
    if (this.state !== "paused") {
      return { ok: false, message: "当前没有暂停中的任务", status: this.snapshot() };
    }
    this.token?.resume();
    this.state = "running";
    this.progress.message = "已继续";
    this.publish(true);
    logger.info("[同步任务] 已继续");
    return { ok: true, message: "已继续", status: this.snapshot() };
  }

  stop(): ControlResult {
    if (!this.busy) {
      return { ok: false, message: "当前没有运行中的任务", status: this.snapshot() };
    }
    this.stopping = true;
    this.token?.abort();
    this.progress.message = "正在停止…（等待当前请求结束）";
    this.publish(true);
    logger.info("[同步任务] 收到停止请求");
    return { ok: true, message: "正在停止", status: this.snapshot() };
  }

  private report(patch: Partial<SyncProgress>): void {
    this.progress = { ...this.progress, ...patch };
    this.publish(false);
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
