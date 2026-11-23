import { Context } from "koishi";
import { DataService } from "@koishijs/plugin-console";
import {} from "@koishijs/plugin-console";
import type { DeltaSyncConfig, NotifyConfig } from "../config";
import type { SyncLogRow } from "./databaseExtension";
import { PageSyncer, type SyncNotifyItem } from "../sync/pageSync";
import { ImageSyncer } from "../sync/imgSync";
import { runIncrementalSync } from "../sync/incrementalSync";
import { SyncNotifier } from "../services/syncNotifier";
import { SyncRepository, SYNC_CONFIG_KEYS } from "../services/syncRepository";
import type { SyncChangeListItem } from "../services/syncRepository";
import {
  SyncTaskManager,
  type ControlResult,
  type SyncTaskSnapshot,
} from "../services/syncTaskManager";
import { getErrorMessage, logger } from "../utils/tools";

/** 控制台看到的完整状态 = 任务状态 + 定时 / 水位信息 */
export interface SyncPanelStatus extends SyncTaskSnapshot {
  cron: string;
  nextRunAt?: number;
  lastSyncTime?: string;
  lastResult?: string;
  imageIndexCount: number;
  logCount: number;
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
  action: "start" | "pause" | "resume" | "stop";
}

export interface SyncCronPayload {
  expression: string;
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
    "sync/cron"(payload: SyncCronPayload): Promise<ControlResult>;
    "sync/clearLogs"(): Promise<{ removed: number }>;
  }
}

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

/** 同步运维面板：任务控制 + 最近更改 + 定时配置 */
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
  private cronJobId = "";
  private cronExpression: string;
  private statusCache: SyncPanelStatus;

  constructor(
    private readonly ctx: Context,
    private readonly config: DeltaSyncConfig & Pick<NotifyConfig, "notifyGroupIds" | "notifyBotPlatform">,
  ) {
    this.repo = new SyncRepository(ctx);
    this.cronExpression = config.syncCron || "15 * * * *";

    const notifier = new SyncNotifier(
      ctx,
      config.notifyGroupIds,
      config.notifyBotPlatform,
    );
    this.notifyFn = notifier.enabled
      ? (items) => void notifier.notify(items)
      : undefined;

    this.manager = new SyncTaskManager(ctx, () => this.publish());
    this.statusCache = this.compose(this.manager.snapshot());

    ctx.plugin(ConsoleSyncData, this);
    ctx.set("syncConsole", this);
    this.registerListeners(ctx);
    void this.initialize();
  }

  /** 读配置 → 注册定时任务 → 推送一次初始状态 */
  private async initialize(): Promise<void> {
    await this.repo.loadConfig();
    const stored = this.repo.getConfig(SYNC_CONFIG_KEYS.cronSchedule);
    if (stored) this.cronExpression = stored;

    this.scheduleCron();
    try {
      const page = await this.repo.listChanges({ limit: 1 });
      this.statusCache = {
        ...this.statusCache,
        logCount: page.totalAll,
        imageIndexCount: await this.repo.countImages(),
      };
    } catch (error) {
      logger.debug(`初始化同步统计失败：${getErrorMessage(error)}`);
    }
    this.publish();
  }

  // ------------------------------------------------------------- 状态组装

  status(): SyncPanelStatus {
    const snapshot = this.manager.snapshot();
    const next = this.ctx
      .oniCron.list()
      .find((job) => job.id === this.cronJobId)?.next;
    const lastSyncTime = this.repo.getLastSyncTime();
    const composed = this.compose(snapshot);
    composed.cron = this.cronExpression;
    composed.nextRunAt = next ? next.getTime() : undefined;
    composed.lastSyncTime = lastSyncTime
      ? new Date(lastSyncTime).toISOString()
      : undefined;
    composed.lastResult = this.repo.getConfig(SYNC_CONFIG_KEYS.lastResult) || undefined;
    this.statusCache = composed;
    return composed;
  }

  private compose(snapshot: SyncTaskSnapshot): SyncPanelStatus {
    return {
      ...snapshot,
      cron: this.cronExpression,
      nextRunAt: this.statusCache?.nextRunAt,
      lastSyncTime: this.statusCache?.lastSyncTime,
      lastResult: this.statusCache?.lastResult,
      imageIndexCount: this.statusCache?.imageIndexCount ?? 0,
      logCount: this.statusCache?.logCount ?? 0,
    };
  }

  private publish(): void {
    this.ctx.get("console")?.patch("onisync", this.status());
  }
  // ---------------------------------------------------------------- 定时任务

  private scheduleCron(): void {
    if (this.cronJobId) {
      this.ctx.oniCron.cancel(this.cronJobId);
      this.cronJobId = "";
    }

    this.cronJobId = this.ctx.oniCron(
      this.cronExpression,
      async () => {
        const result = await this.startTask("cron");
        if (!result.ok) logger.warn(`[同步任务] 定时触发被忽略：${result.message}`);
      },
      "增量同步（页面 + 图片）",
    );

    if (!this.cronJobId) {
      logger.error(
        `[同步任务] cron 表达式非法「${this.cronExpression}」，定时同步已停用；可用 .sync 命令手动同步`,
      );
      return;
    }
    const next = this.ctx.oniCron.list().find((job) => job.id === this.cronJobId)?.next;
    logger.info(
      `[同步任务] 已注册增量同步定时任务：${this.cronExpression}` +
        (next ? `（下次 ${next.toLocaleString()}）` : ""),
    );
  }

  async updateCron(expression: string): Promise<ControlResult> {
    const trimmed = (expression || "").trim();
    if (!trimmed) {
      return { ok: false, message: "cron 表达式不能为空", status: this.status() };
    }

    const previous = this.cronExpression;
    this.cronExpression = trimmed;
    this.scheduleCron();

    if (!this.cronJobId) {
      // 表达式非法：回滚，避免把用户原来的配置搞坏
      this.cronExpression = previous;
      this.scheduleCron();
      return {
        ok: false,
        message: `cron 表达式非法：${trimmed}，已回滚为 ${previous}`,
        status: this.status(),
      };
    }

    try {
      await this.repo.setConfig(SYNC_CONFIG_KEYS.cronSchedule, trimmed);
    } catch (error) {
      logger.warn(`保存 cron 配置失败：${getErrorMessage(error)}`);
    }
    this.publish();
    return {
      ok: true,
      message: `定时任务已更新为 ${trimmed}`,
      status: this.status(),
    };
  }

  // ------------------------------------------------------------ 任务控制

  async startTask(trigger: string): Promise<ControlResult> {
    if (this.manager.busy) {
      return {
        ok: false,
        message: "已有同步任务在运行，请先停止或等待完成",
        status: this.status(),
      };
    }

    const ready = await this.ctx.wikiBot.ensureReady();
    if (!ready.gg || !ready.bwiki) {
      return {
        ok: false,
        message: `Wiki 机器人未就绪（WIKIGG ${ready.gg ? "✅" : "❌"} / bwiki ${ready.bwiki ? "✅" : "❌"}）`,
        status: this.status(),
      };
    }

    const pageSyncer = new PageSyncer(
      this.ctx.wikiBot.getGGBot(),
      this.ctx.wikiBot.getBWikiBot(),
      { database: this.ctx.database },
    );
    const imageSyncer = new ImageSyncer(
      this.ctx.wikiBot.getGGBot(),
      this.ctx.wikiBot.getBWikiBot(),
    );

    const result = await this.manager.start(trigger, async (token, report) => {
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
          fallbackHours: Math.max(1, this.config.syncFallbackHours ?? 3),
          maxPagesPerRun: Math.max(1, this.config.syncMaxPagesPerRun ?? 300),
          maxImagesPerRun: Math.max(1, this.config.syncMaxImagesPerRun ?? 100),
          checkImages: this.config.syncCheckImages ?? true,
        },
      );

      // 收尾时补一次统计信息（图片索引数量 / 日志条数）
      const page = await this.repo.listChanges({ limit: 1 });
      this.statusCache = {
        ...this.statusCache,
        logCount: page.totalAll,
        imageIndexCount: await this.repo.countImages(),
      };
      this.publish();
      return summary;
    });

    return { ...result, status: this.status() };
  }

  async control(
    action: SyncControlPayload["action"],
  ): Promise<ControlResult> {
    switch (action) {
      case "start":
        return this.startTask("console");
      case "pause":
        return { ...this.manager.pause(), status: this.status() };
      case "resume":
        return { ...this.manager.resume(), status: this.status() };
      case "stop":
        return { ...this.manager.stop(), status: this.status() };
      default:
        return {
          ok: false,
          message: `未知操作：${action}`,
          status: this.status(),
        };
    }
  }

  // -------------------------------------------------------------- 最近更改

  async listLogs(payload: SyncLogQueryPayload = {}): Promise<SyncLogListPayload> {
    const page = await this.repo.listChanges(payload);
    this.statusCache = { ...this.statusCache, logCount: page.totalAll };
    return page;
  }

  /**
   * 点击某条记录时取详情。
   * `diffHtml` 为空则实时向源站请求 diff 并缓存，避免一次同步就把 5000 份 diff 全存下来。
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

  async clearLogs(): Promise<{ removed: number }> {
    const removed = await this.repo.clearChanges();
    this.statusCache = { ...this.statusCache, logCount: 0 };
    this.publish();
    return { removed };
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
    // 控制动作会改动远端 wiki，按写操作对待
    ctx.console.addListener("sync/control", (payload) => this.control(payload.action), {
      authority: 2,
    });
    ctx.console.addListener("sync/cron", (payload) => this.updateCron(payload.expression), {
      authority: 2,
    });
    ctx.console.addListener("sync/clearLogs", () => this.clearLogs(), {
      authority: 2,
    });
  }
}
