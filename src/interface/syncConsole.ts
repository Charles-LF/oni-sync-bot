import { Context } from "koishi";
import { DataService } from "@koishijs/plugin-console";
import {} from "@koishijs/plugin-console";
import type { DeltaSyncConfig, NotifyConfig } from "../config";
import type {
  SyncLogRow,
  SyncRunItemRow,
  SyncRunLogRow,
  SyncRunRow,
} from "../infrastructure/persistence/databaseExtension";
import { PageSyncer } from "../sync/pageSync";
import { ImageSyncer } from "../sync/imgSync";
import type { SyncLoopHooks, SyncLoopProgress } from "../sync/hooks";
import { FullSyncUseCase, type FullSyncTarget } from "../application/sync/fullSyncUseCase";
import { SyncNotifier } from "../infrastructure/notify/syncNotifier";
import { SyncRepository, SYNC_CONFIG_KEYS } from "../infrastructure/persistence/syncRepository";
import type { SyncChangeListItem } from "../infrastructure/persistence/syncRepository";
import { SyncTaskManager } from "../infrastructure/sync/syncTaskManager";
import { SyncAbortedError, type RunToken } from "../domain/sync/runToken";
import type {
  ControlResult,
  ProgressReporter,
  SyncPanelSnapshot,
  SyncTaskId,
  SyncTaskMeta,
} from "../application/sync/syncTypes";
import type { SyncNotifyItem } from "../sync/pageSync";
import { getErrorMessage, logger } from "../utils/tools";
import { IncrementalSyncUseCase } from "../application/sync/incrementalSyncUseCase";
import {
  IgnoreListUseCase,
  type IgnoreRuleRepositoryPort,
} from "../application/sync/ignoreListUseCase";
import type { StoredIgnoreRule } from "../domain/sync/ignoreRule";
import { SyncIgnoreRepository } from "../infrastructure/persistence/syncIgnoreRepository";
import {
  SyncRunRepository,
  type SyncRunState,
} from "../infrastructure/persistence/syncRunRepository";
import {
  SyncRunRecorder,
  type SyncLogEvent,
} from "../infrastructure/console/syncRunRecorder";

/** 控制台看到的完整状态 = 任务状态 + 水位 / 统计 */
export interface SyncPanelStatus extends SyncPanelSnapshot {
  /** 增量同步的下次触发时间（由代码里的 cron 决定，页面只读） */
  nextDeltaAt?: number;
  deltaCron: string;
  lastSyncTime?: string;
  logCount: number;
  imageIndexCount: number;
  /** 忽略规则条数 */
  ignoreCount: number;
}

export interface SyncLogQueryPayload {
  offset?: number;
  limit?: number;
  keyword?: string;
}

export interface SyncLogListPayload {
  entries: SyncChangeListItem[];
  total: number;
  totalAll: number;
}

export interface SyncControlPayload {
  taskId: SyncTaskId;
  action: "start" | "pause" | "resume" | "stop";
}

export interface SyncDetailPayload {
  id: string;
}

/** 点开任务卡片时：优先按 runId，其次取该任务最近一次运行 */
export interface SyncTaskDetailPayload {
  taskId?: SyncTaskId;
  runId?: string;
}

/** 任务详情弹窗的数据 */
export interface SyncTaskDetail {
  run: SyncRunRow;
  items: {
    synced: SyncRunItemRow[];
    skipped: SyncRunItemRow[];
    failed: SyncRunItemRow[];
  };
  logs: SyncRunLogRow[];
}

export interface SyncIgnorePayload {
  type: string;
  name: string;
  reason?: string;
}

export interface SyncIgnoreResult {
  ok: boolean;
  message: string;
  rules: StoredIgnoreRule[];
}

declare module "koishi" {
  interface Context {
    /** 同步运维服务（见 plugins/syncConsole.ts） */
    syncConsole: SyncConsole;
  }
}

declare module "@koishijs/console" {
  namespace Console {
    interface Services {
      /** 同步任务状态（轻量，高频推送） */
      onisync: DataService<SyncPanelStatus>;
    }
  }

  interface Events {
    "sync/status"(): SyncPanelStatus;
    "sync/logs"(payload?: SyncLogQueryPayload): Promise<SyncLogListPayload>;
    "sync/detail"(payload: SyncDetailPayload): Promise<SyncLogRow | null>;
    "sync/control"(payload: SyncControlPayload): Promise<ControlResult>;
    /** 任务详情：本次运行的条目 + 完整日志 */
    "sync/taskDetail"(
      payload: SyncTaskDetailPayload,
    ): Promise<SyncTaskDetail | null>;
    "sync/ignore/list"(): Promise<StoredIgnoreRule[]>;
    "sync/ignore/add"(payload: SyncIgnorePayload): Promise<SyncIgnoreResult>;
    "sync/ignore/remove"(payload: SyncIgnorePayload): Promise<SyncIgnoreResult>;
    /** 仅用于文档：服务端通过 broadcast 推送实时日志，前端用 ctx.on 订阅 */
    "sync/log"(payload: SyncLogEvent): void;
  }
}

/** 页面上的任务清单：只有增量同步不可手动控制 */
const TASK_META: SyncTaskMeta[] = [
  {
    id: "delta",
    label: "增量同步",
    description: "按水位同步新编辑器与图片，由代码按 cron 自动运行",
    controllable: false,
  },
  {
    id: "pages",
    label: "全量同步页面",
    description: "遍历原站主命名空间全部页面写入 bwiki",
    controllable: true,
  },
  {
    id: "images",
    label: "全量同步图片",
    description: "遍历原站全部文件，SHA1 不一致才转存",
    controllable: true,
  },
  {
    id: "modules",
    label: "全量同步模块",
    description: "遍历 Module 命名空间全部页面写入 bwiki",
    controllable: true,
  },
];

/** 暴露给控制台的状态数据源 */
class ConsoleSyncData extends DataService<SyncPanelStatus> {
  constructor(
    ctx: Context,
    private readonly provider: SyncConsole,
  ) {
    super(ctx, "onisync", { authority: 0 });
  }

  async get(): Promise<SyncPanelStatus> {
    return this.provider.status();
  }
}

/**
 * 同步运维面板：任务控制 + 最近更改 + 增量水位 + 忽略规则。
 *
 * 分层职责：
 * - 本类属于接口层（适配 Koishi 控制台 / 命令），只做参数编排与事件注册；
 * - 「是否跳过」的判定在领域层（`domain/sync`），调度与水位在应用层用例；
 * - 执行器（`sync/*`）只搬数据，日志通过 `SyncRunRecorder` 落库并广播。
 */
export class SyncConsole {
  public static readonly inject = {
    database: { required: true },
    console: { required: true },
    wikiBot: { required: true },
    oniCron: { required: true },
  };

  public readonly repo: SyncRepository;
  public readonly manager: SyncTaskManager;
  public readonly ignoreRepo: SyncIgnoreRepository;
  public readonly runRepo: SyncRunRepository;

  private readonly ignoreUseCase: IgnoreListUseCase;
  private readonly notifyFn?: (items: SyncNotifyItem[]) => void;
  /** 增量同步的 cron：只来自配置，页面不可改 */
  private readonly deltaCron: string;
  private cronJobId = "";
  private statusCache: Partial<SyncPanelStatus> = {};
  /** 各任务最近一次运行 id（内存缓存，重启后由数据库兜底） */
  private readonly latestRunIds = new Map<SyncTaskId, string>();

  constructor(
    private readonly ctx: Context,
    private readonly config: DeltaSyncConfig &
      Pick<NotifyConfig, "notifyGroupIds" | "notifyBotPlatform">,
  ) {
    this.repo = new SyncRepository(ctx);
    this.ignoreRepo = new SyncIgnoreRepository(ctx);
    this.runRepo = new SyncRunRepository(ctx);
    this.ignoreUseCase = new IgnoreListUseCase(
      this.ignoreRepo as IgnoreRuleRepositoryPort,
    );
    this.deltaCron = config.syncCron || "15 * * * *";

    const notifier = new SyncNotifier(
      ctx,
      config.notifyGroupIds,
      config.notifyBotPlatform,
    );
    this.notifyFn = notifier.enabled
      ? (items) => void notifier.notify(items)
      : undefined;

    this.manager = new SyncTaskManager(ctx, TASK_META, () => this.publish(), (taskId, level, message) => {
      // 生命周期日志（启动 / 暂停 / 完成…）也进网页日志流，服务端不再打 info
      this.broadcastLog({
        runId: this.latestRunIds.get(taskId) ?? `task-${taskId}`,
        taskId,
        level,
        message,
        at: Date.now(),
        seq: 0,
      });
    });
    ctx.plugin(ConsoleSyncData, this);
    ctx.set("syncConsole", this);

    this.registerListeners(ctx);
    void this.initialize();
  }

  /** 读库 → 收尾中断的运行记录 → 补种内置忽略规则 → 注册增量 cron → 推送一次 */
  private async initialize(): Promise<void> {
    await this.repo.loadConfig();
    await this.runRepo.closeDanglingRuns();
    await this.seedIgnoreDefaults();
    this.scheduleDeltaCron();
    await this.refreshStats();
    this.publish();
  }

  /** 内置忽略规则只在版本变化时补种一次；失败只告警，不影响启动 */
  private async seedIgnoreDefaults(): Promise<void> {
    try {
      const inserted = await this.ignoreRepo.seedDefaults();
      if (inserted > 0) {
        logger.info(`[忽略规则] 已补种 ${inserted} 条内置规则`);
      }
    } catch (error) {
      logger.warn(`[忽略规则] 补种内置规则失败：${getErrorMessage(error)}`);
    }
  }

  // ------------------------------------------------------------- 状态组装

  status(): SyncPanelStatus {
    const snapshot = this.manager.snapshot();
    const next = this.ctx
      .oniCron.list()
      .find((job) => job.id === this.cronJobId)?.next;
    const lastSync = this.repo.getLastSyncTime();

    const status: SyncPanelStatus = {
      ...snapshot,
      deltaCron: this.deltaCron,
      nextDeltaAt: next ? next.getTime() : undefined,
      lastSyncTime: lastSync ? new Date(lastSync).toISOString() : undefined,
      logCount: this.statusCache.logCount ?? 0,
      imageIndexCount: this.statusCache.imageIndexCount ?? 0,
      ignoreCount: this.statusCache.ignoreCount ?? 0,
    };

    // 把每个任务上次的结果补回快照（来自数据库，重启后仍可见）
    for (const task of status.tasks) {
      if (!task.lastSummary) {
        task.lastSummary = this.repo.getConfig(
          `${SYNC_CONFIG_KEYS.lastResultPrefix}${task.id}`,
        ) || undefined;
      }
      task.lastRunId = this.latestRunIds.get(task.id);
    }

    this.statusCache = { ...status };
    return status;
  }

  private publish(): void {
    this.ctx.get("console")?.patch("onisync", this.status());
  }

  private async refreshStats(): Promise<void> {
    try {
      const page = await this.repo.listChanges({ limit: 1 });
      this.statusCache.logCount = page.totalAll;
      this.statusCache.imageIndexCount = await this.repo.countImages();
      this.statusCache.ignoreCount = (await this.ignoreRepo.list()).length;
    } catch (error) {
      logger.debug(`刷新同步统计失败：${getErrorMessage(error)}`);
    }
  }

  // ---------------------------------------------------------------- 定时任务

  /** 增量同步的调度固定由配置决定，控制台不提供修改入口 */
  private scheduleDeltaCron(): void {
    if (this.cronJobId) {
      this.ctx.oniCron.cancel(this.cronJobId);
      this.cronJobId = "";
    }

    this.cronJobId = this.ctx.oniCron(
      this.deltaCron,
      async () => {
        const result = await this.startDelta("cron");
        if (!result.ok) {
          logger.warn(`[同步任务] 定时增量同步被跳过：${result.message}`);
        }
      },
      "增量同步（页面 + 图片）",
    );

    if (!this.cronJobId) {
      logger.error(
        `[同步任务] 增量同步的 cron 表达式非法「${this.deltaCron}」，定时同步已停用`,
      );
      return;
    }
    const next = this.ctx
      .oniCron.list()
      .find((job) => job.id === this.cronJobId)?.next;
    logger.info(
      `[同步任务] 增量同步已排期：${this.deltaCron}` +
        (next ? `（下次 ${next.toLocaleString()}）` : ""),
    );
  }

  // ------------------------------------------------------------ 任务控制

  /** 控制台/指令触发的入口：增量同步在这里会被拒绝 */
  async control(payload: SyncControlPayload): Promise<ControlResult> {
    const { taskId, action } = payload;

    if (action === "start") {
      if (taskId === "delta") {
        return {
          ok: false,
          message: "增量同步由代码自动调度，不支持手动启动",
          status: this.status(),
        };
      }
      return this.startFullTask(taskId);
    }

    const result =
      action === "pause"
        ? this.manager.pause(taskId)
        : action === "resume"
          ? this.manager.resume(taskId)
          : this.manager.stop(taskId);
    return { ...result, status: this.status() };
  }

  /** 增量同步：定时任务与 sync 命令共用 */
  async startDelta(trigger: string): Promise<ControlResult> {
    const ready = await this.ensureReady();
    if (!ready.ok) {
      return { ok: false, message: ready.message, status: this.status() };
    }

    const ignoreRules = await this.ignoreRepo.loadRuleSet();
    const pageSyncer = new PageSyncer(
      this.ctx.wikiBot.getGGBot(),
      this.ctx.wikiBot.getBWikiBot(),
      { database: this.ctx.database, ignoreRules },
    );
    const imageSyncer = new ImageSyncer(
      this.ctx.wikiBot.getGGBot(),
      this.ctx.wikiBot.getBWikiBot(),
      { ignoreRules },
    );

    const result = await this.manager.start(
      "delta",
      trigger,
      async (token, report) => {
        const recorder = await this.beginRun("delta", trigger);
        try {
          const useCase = new IncrementalSyncUseCase(
            {
              source: this.ctx.wikiBot.getGGBot(),
              target: this.ctx.wikiBot.getBWikiBot(),
              pages: pageSyncer,
              images: imageSyncer,
              repo: this.repo,
              notify: this.notifyFn,
              reporter: recorder,
            },
            {
              maxLogRecords: this.config.syncLogLimit ?? 5000,
              overlapMs: Math.max(0, this.config.syncOverlapSeconds ?? 10) * 1000,
              fallbackHours: Math.max(1, this.config.syncFallbackHours ?? 24),
              maxPagesPerRun: Math.max(1, this.config.syncMaxPagesPerRun ?? 300),
              maxImagesPerRun: Math.max(1, this.config.syncMaxImagesPerRun ?? 100),
              checkImages: this.config.syncCheckImages ?? true,
              ignoreRules,
            },
          );

          const summary = await useCase.execute(token, report);
          await this.finishRun("delta", summary.message);
          await recorder.finish({
            state: "completed",
            message: summary.message,
            total: summary.pages + summary.images,
            synced: summary.synced,
            skipped: summary.skipped,
            failed: summary.failed,
          });
          return summary;
        } catch (error) {
          await recorder.finish({
            state: runStateOf(error),
            message: getErrorMessage(error),
          });
          throw error;
        }
      },
    );

    return { ...result, status: this.status() };
  }

  /** 全量页面 / 图片 / 模块：可在面板上开始、暂停、停止 */
  private async startFullTask(taskId: FullSyncTarget): Promise<ControlResult> {
    const ready = await this.ensureReady();
    if (!ready.ok) {
      return { ok: false, message: ready.message, status: this.status() };
    }

    const ignoreRules = await this.ignoreRepo.loadRuleSet();
    const useCase = new FullSyncUseCase({
      source: this.ctx.wikiBot.getGGBot(),
      target: this.ctx.wikiBot.getBWikiBot(),
      database: this.ctx.database,
      ignoreRules,
    });

    const result = await this.manager.start(
      taskId,
      "console",
      async (token, report) => {
        const recorder = await this.beginRun(taskId, "console");
        const hooks = this.createHooks(token, report, taskId, recorder);

        try {
          const summary = await useCase.execute(taskId, hooks);
          await this.finishRun(taskId, summary.message);
          await recorder.finish({
            state: "completed",
            message: summary.message,
            total: summary.total,
            synced: summary.synced,
            skipped: summary.skipped,
            failed: summary.failed,
          });
          return summary;
        } catch (error) {
          await recorder.finish({
            state: runStateOf(error),
            message: getErrorMessage(error),
          });
          throw error;
        }
      },
      true,
    );

    return { ...result, status: this.status() };
  }

  /** 把循环钩子接到任务管理器：checkpoint 负责暂停/停止，onProgress 负责上报 */
  private createHooks(
    token: RunToken,
    report: ProgressReporter,
    taskId: SyncTaskId,
    recorder?: SyncRunRecorder,
  ): SyncLoopHooks {
    const phaseByTask: Record<SyncTaskId, string> = {
      delta: "增量同步",
      pages: "同步页面",
      images: "同步图片",
      modules: "同步模块",
    };

    return {
      checkpoint: () => token.checkpoint(),
      onProgress: (info: SyncLoopProgress) => {
        report({
          phase: info.phase || phaseByTask[taskId],
          current: info.current,
          total: info.total,
          synced: info.synced,
          skipped: info.skipped,
          failed: info.failed,
          message: info.title ? `正在处理 ${info.title}` : "准备中…",
        });
      },
      log: (level, message) => recorder?.log(level, message),
      item: (item) => recorder?.item(item),
    };
  }

  // ------------------------------------------------------------ 运行记录

  /** 开一次运行记录；数据库异常时降级为「只广播不落库」 */
  private async beginRun(
    taskId: SyncTaskId,
    trigger: string,
  ): Promise<SyncRunRecorder> {
    let runId = "";
    try {
      runId = await this.runRepo.begin(taskId, trigger);
    } catch (error) {
      logger.warn(`创建运行记录失败，本次仅广播日志：${getErrorMessage(error)}`);
      runId = SyncRunRepository.createId(taskId);
    }
    this.latestRunIds.set(taskId, runId);

    return new SyncRunRecorder(this.ctx, this.runRepo, runId, taskId, {
      logLimit: this.config.syncTaskLogLimit ?? 500,
      runKeep: this.config.syncRunKeep ?? 20,
      broadcast: (event) => this.broadcastLog(event),
    });
  }

  /** 实时日志：网页端订阅 `sync/log`，无需等落库 */
  private broadcastLog(event: SyncLogEvent): void {
    try {
      void this.ctx.get("console")?.broadcast("sync/log", event, {
        authority: 0,
      });
    } catch (error) {
      logger.debug(`广播同步日志失败：${getErrorMessage(error)}`);
    }
  }

  private async taskDetail(
    payload: SyncTaskDetailPayload = {},
  ): Promise<SyncTaskDetail | null> {
    const run = payload.runId
      ? await this.runRepo.getRun(payload.runId)
      : await this.runRepo.latestRun(payload.taskId);
    if (!run) return null;

    const [items, logs] = await Promise.all([
      this.runRepo.listItems(run.id),
      this.runRepo.listLogs(run.id),
    ]);

    return {
      run,
      items: {
        synced: items.filter((item) => item.action === "synced"),
        skipped: items.filter((item) => item.action === "skipped"),
        failed: items.filter((item) => item.action === "failed"),
      },
      logs,
    };
  }

  private async finishRun(taskId: SyncTaskId, summary: string): Promise<void> {
    try {
      await this.repo.setConfig(
        `${SYNC_CONFIG_KEYS.lastResultPrefix}${taskId}`,
        summary,
      );
    } catch (error) {
      logger.debug(`保存任务结果失败：${getErrorMessage(error)}`);
    }
    await this.refreshStats();
    this.publish();
  }

  private async ensureReady(): Promise<{ ok: boolean; message: string }> {
    const ready = await this.ctx.wikiBot.ensureReady();
    if (ready.gg && ready.bwiki) return { ok: true, message: "" };
    return {
      ok: false,
      message: `Wiki 机器人未就绪（WIKIGG ${ready.gg ? "✅" : "❌"} / bwiki ${ready.bwiki ? "✅" : "❌"}）`,
    };
  }

  // -------------------------------------------------------------- 忽略规则

  async listIgnoreRules(): Promise<StoredIgnoreRule[]> {
    return this.ignoreUseCase.list();
  }

  async addIgnoreRule(payload: SyncIgnorePayload): Promise<SyncIgnoreResult> {
    try {
      const rule = await this.ignoreUseCase.add(payload);
      this.statusCache.ignoreCount = (await this.ignoreUseCase.list()).length;
      this.publish();
      return {
        ok: true,
        message: `已添加忽略规则：${rule.type}/${rule.name}`,
        rules: await this.ignoreUseCase.list(),
      };
    } catch (error) {
      return {
        ok: false,
        message: getErrorMessage(error),
        rules: await this.ignoreUseCase.list().catch(() => []),
      };
    }
  }

  async removeIgnoreRule(
    payload: SyncIgnorePayload,
  ): Promise<SyncIgnoreResult> {
    try {
      const message = await this.ignoreUseCase.remove(payload);
      this.statusCache.ignoreCount = (await this.ignoreUseCase.list()).length;
      this.publish();
      return { ok: true, message, rules: await this.ignoreUseCase.list() };
    } catch (error) {
      return {
        ok: false,
        message: getErrorMessage(error),
        rules: await this.ignoreUseCase.list().catch(() => []),
      };
    }
  }

  // -------------------------------------------------------------- 最近更改

  async listLogs(payload: SyncLogQueryPayload = {}): Promise<SyncLogListPayload> {
    const page = await this.repo.listChanges(payload);
    this.statusCache.logCount = page.totalAll;
    return page;
  }

  /**
   * 点击某条记录时取详情。
   * `diffHtml` 为空则实时向源站请求 diff 并缓存；用 unified 格式，避免整表 HTML 撑爆体积。
   */
  async detail(id: string): Promise<SyncLogRow | null> {
    const row = await this.repo.getChange(id);
    if (!row) return null;
    if (row.diffHtml || !row.revid) return row;

    try {
      const res = await this.ctx.wikiBot.getGGBot().request({
        action: "compare",
        format: "json",
        formatversion: "2",
        fromrev: row.parentid || "prev",
        torev: row.revid,
        prop: "diff",
        difftype: "unified",
      });
      const html: string = res?.compare?.body || res?.compare?.["*"] || "";
      if (html) {
        await this.repo.saveDiffHtml(id, html);
        row.diffHtml = html;
      }
    } catch (error) {
      logger.debug(`获取 ${row.title} 的 diff 失败：${getErrorMessage(error)}`);
    }
    return row;
  }

  // ---------------------------------------------------------------- 监听器

  private registerListeners(ctx: Context): void {
    ctx.console.addListener("sync/status", () => this.status(), { authority: 0 });
    ctx.console.addListener("sync/logs", (payload) => this.listLogs(payload), {
      authority: 0,
    });
    ctx.console.addListener("sync/detail", (payload) => this.detail(payload.id), {
      authority: 0,
    });
    ctx.console.addListener(
      "sync/taskDetail",
      (payload) => this.taskDetail(payload),
      { authority: 0 },
    );
    ctx.console.addListener("sync/ignore/list", () => this.listIgnoreRules(), {
      authority: 0,
    });
    // 会改动远端 wiki，按写操作对待；全量同步权重最高（4）
    ctx.console.addListener("sync/control", (payload) => this.control(payload), {
      authority: 4,
    });
    ctx.console.addListener(
      "sync/ignore/add",
      (payload) => this.addIgnoreRule(payload),
      { authority: 4 },
    );
    ctx.console.addListener(
      "sync/ignore/remove",
      (payload) => this.removeIgnoreRule(payload),
      { authority: 4 },
    );
  }
}

/** 主动停止与真异常要分开记，详情里才能一眼看出是人为中断还是报错 */
function runStateOf(error: unknown): Exclude<SyncRunState, "running"> {
  if (
    error instanceof SyncAbortedError ||
    (error as { name?: string } | null)?.name === "SyncAbortedError"
  ) {
    return "stopped";
  }
  return "failed";
}
