import { Context } from "koishi";
import { DataService } from "@koishijs/plugin-console";
import {} from "@koishijs/plugin-console";
import type { DeltaSyncConfig, NotifyConfig } from "../config";
import type { SyncLogRow } from "./databaseExtension";
import { PageSyncer } from "../sync/pageSync";
import { ImageSyncer } from "../sync/imgSync";
import { ModuleSyncer } from "../sync/moduleSync";
import { runIncrementalSync } from "../sync/incrementalSync";
import type { SyncLoopHooks, SyncLoopProgress } from "../sync/hooks";
import { SyncNotifier } from "../services/syncNotifier";
import { SyncRepository, SYNC_CONFIG_KEYS } from "../services/syncRepository";
import type { SyncChangeListItem } from "../services/syncRepository";
import {
  SyncTaskManager,
  type ControlResult,
  type ProgressReporter,
  type RunToken,
  type SyncPanelSnapshot,
  type SyncTaskId,
  type SyncTaskMeta,
  type SyncRunSummary,
} from "../services/syncTaskManager";
import type { SyncNotifyItem } from "../sync/pageSync";
import { getErrorMessage, logger } from "../utils/tools";

/** 控制台看到的完整状态 = 任务状态 + 水位 / 统计 */
export interface SyncPanelStatus extends SyncPanelSnapshot {
  /** 增量同步的下次触发时间（由代码里的 cron 决定，页面只读） */
  nextDeltaAt?: number;
  deltaCron: string;
  lastSyncTime?: string;
  logCount: number;
  imageIndexCount: number;
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

/** 同步运维面板：任务控制 + 最近更改 + 增量水位 */
export class SyncConsole {
  public static readonly inject = {
    database: { required: true },
    console: { required: true },
    wikiBot: { required: true },
    oniCron: { required: true },
  };

  public readonly repo: SyncRepository;
  public readonly manager: SyncTaskManager;
  private readonly notifyFn?: (items: SyncNotifyItem[]) => void;
  /** 增量同步的 cron：只来自配置，页面不可改 */
  private readonly deltaCron: string;
  private cronJobId = "";
  private statusCache: Partial<SyncPanelStatus> = {};

  constructor(
    private readonly ctx: Context,
    private readonly config: DeltaSyncConfig &
      Pick<NotifyConfig, "notifyGroupIds" | "notifyBotPlatform">,
  ) {
    this.repo = new SyncRepository(ctx);
    this.deltaCron = config.syncCron || "15 * * * *";

    const notifier = new SyncNotifier(
      ctx,
      config.notifyGroupIds,
      config.notifyBotPlatform,
    );
    this.notifyFn = notifier.enabled
      ? (items) => void notifier.notify(items)
      : undefined;

    this.manager = new SyncTaskManager(ctx, TASK_META, () => this.publish());
    ctx.plugin(ConsoleSyncData, this);
    ctx.set("syncConsole", this);

    this.registerListeners(ctx);
    void this.initialize();
  }

  /** 读库 → 注册增量 cron → 推送一次 */
  private async initialize(): Promise<void> {
    await this.repo.loadConfig();
    this.scheduleDeltaCron();
    await this.refreshStats();
    this.publish();
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
    };

    // 把每个任务上次的结果补回快照（来自数据库，重启后仍可见）
    for (const task of status.tasks) {
      if (!task.lastSummary) {
        task.lastSummary = this.repo.getConfig(
          `${SYNC_CONFIG_KEYS.lastResultPrefix}${task.id}`,
        ) || undefined;
      }
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
    if (!ready.ok) return { ok: false, message: ready.message, status: this.status() };

    const pageSyncer = new PageSyncer(
      this.ctx.wikiBot.getGGBot(),
      this.ctx.wikiBot.getBWikiBot(),
      { database: this.ctx.database },
    );
    const imageSyncer = new ImageSyncer(
      this.ctx.wikiBot.getGGBot(),
      this.ctx.wikiBot.getBWikiBot(),
    );

    const result = await this.manager.start("delta", trigger, async (token, report) => {
      const summary = await runIncrementalSync(
        {
          source: this.ctx.wikiBot.getGGBot(),
          target: this.ctx.wikiBot.getBWikiBot(),
          pages: pageSyncer,
          images: imageSyncer,
          repo: this.repo,
          notify: this.notifyFn,
        },
        token,
        report,
        {
          maxLogRecords: this.config.syncLogLimit ?? 5000,
          overlapMs: Math.max(0, this.config.syncOverlapSeconds ?? 10) * 1000,
          fallbackHours: Math.max(1, this.config.syncFallbackHours ?? 24),
          maxPagesPerRun: Math.max(1, this.config.syncMaxPagesPerRun ?? 300),
          maxImagesPerRun: Math.max(1, this.config.syncMaxImagesPerRun ?? 100),
          checkImages: this.config.syncCheckImages ?? true,
        },
      );
      await this.finishRun("delta", summary.message);
      return summary;
    });

    return { ...result, status: this.status() };
  }

  /** 全量页面 / 图片 / 模块：可在面板上开始、暂停、停止 */
  private async startFullTask(taskId: SyncTaskId): Promise<ControlResult> {
    const ready = await this.ensureReady();
    if (!ready.ok) return { ok: false, message: ready.message, status: this.status() };

    const { gg, bwiki } = {
      gg: this.ctx.wikiBot.getGGBot(),
      bwiki: this.ctx.wikiBot.getBWikiBot(),
    };

    const result = await this.manager.start(
      taskId,
      "console",
      async (token, report) => {
        const hooks = this.createHooks(token, report, taskId);
        let summary: SyncRunSummary;

        if (taskId === "pages") {
          const stats = await new PageSyncer(gg, bwiki, {
            database: this.ctx.database,
          }).syncAll(hooks);
          summary = {
            synced: stats.synced,
            skipped: stats.skipped,
            failed: stats.failed,
            message: `页面 ${stats.total} 个：同步 ${stats.synced}、跳过 ${stats.skipped}、失败 ${stats.failed}`,
          };
        } else if (taskId === "images") {
          const stats = await new ImageSyncer(gg, bwiki).syncAll(hooks);
          summary = {
            synced: stats.synced,
            skipped: stats.skipped,
            failed: stats.failed,
            message: `图片 ${stats.total} 张：转存 ${stats.synced}、跳过 ${stats.skipped}、失败 ${stats.failed}`,
          };
        } else {
          const stats = await new ModuleSyncer(gg, bwiki).syncAll(hooks);
          summary = {
            synced: stats.synced,
            skipped: stats.skipped,
            failed: stats.failed,
            message: `模块 ${stats.total} 个：同步 ${stats.synced}、跳过 ${stats.skipped}、失败 ${stats.failed}`,
          };
        }

        await this.finishRun(taskId, summary.message);
        return summary;
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
    // 会改动远端 wiki，按写操作对待；全量同步权重最高（4）
    ctx.console.addListener("sync/control", (payload) => this.control(payload), {
      authority: 4,
    });
  }
}
