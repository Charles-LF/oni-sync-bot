import { Mwn } from "mwn";
import {
  getAndProcessPageContent,
  logger,
  formatWikiTime,
  generatePinyinInfo,
  getErrorMessage,
} from "../utils/tools";
import { sleep, withRetry } from "../utils/async";
import { decideIgnore } from "../domain/sync/decision";
import type { IgnoreRuleSet } from "../domain/sync/ignoreRule";
import { reportSyncItem } from "../domain/sync/ports";
import type {
  SyncLoopHooks,
  SyncLoopProgress,
  SyncLoopResult,
} from "./hooks";
import { ABORT_ERROR_NAME } from "./hooks";

/**
 * pageSync 需要的数据库能力（结构化的最小接口）。
 *
 * 说明：`wikipages` 虽然已经通过 `src/plugins/databaseExtension.ts` 里的 `Tables`
 * 接口增强声明过，这里仍刻意保留最小接口，避免与 Koishi 的表类型强耦合。
 * `get<T = unknown>` 是唯一保留的宽松点。
 */
export interface Database {
  set(table: string, query: object, data: object): Promise<unknown>;
  get<T = unknown>(table: string, query: object): Promise<T[]>;
  create(table: string, data: object): Promise<unknown>;
  upsert(table: string, data: object | object[]): Promise<unknown>;
}

/** 同步成功事件信息 */
export interface SyncNotifyItem {
  title: string;
  type: "page" | "image";
  user?: string;
  timestamp?: string;
  comment?: string;
}

/** 页面同步的可调参数 */
export interface PageSyncOptions {
  ignoredPages: Set<string>;
  intervalSuccess: number;
  intervalFailed: number;
  namespace: number;
  batchLimit: number | "max";
  fileNamespacePrefix: string;
  defaultUser: string;
  dbRetryMax: number;
  dbRetryDelay: number;
}

const DEFAULT_OPTIONS: PageSyncOptions = {
  ignoredPages: new Set(["教程", "MediaWiki:Common.css", "首页", "Main Page"]),
  intervalSuccess: 500,
  intervalFailed: 1000,
  namespace: 0,
  batchLimit: "max",
  fileNamespacePrefix: "File:",
  defaultUser: "同步坤器人",
  dbRetryMax: 3,
  dbRetryDelay: 500,
};

export interface PageSyncResult {
  success: boolean;
  reason: string;
  /** 给人看的补充说明（命中哪条忽略规则、错误详情） */
  detail?: string;
}

interface SyncStats {
  successCount: number;
  failCount: number;
  skipCount: number;
}

export interface PageSyncerDependencies {
  /** 数据库实例（可选），用于维护 wikipages 表 */
  database?: Database;
  options?: Partial<PageSyncOptions>;
  /** 数据库驱动的忽略规则（应用层在同步开始前加载一次） */
  ignoreRules?: IgnoreRuleSet;
}

/**
 * 负责页面层面的同步：单页同步与全量同步。
 *
 * 依赖（源站 / 目标站 / 数据库 / 选项）全部由构造函数注入，不再依赖模块级可变单例。
 * **只负责执行**：是否跳过由领域层 `decideIgnore` 判定，
 * 增量调度与水位推进由 `application/sync/incrementalSyncUseCase.ts` 负责。
 */
export class PageSyncer {
  private readonly options: PageSyncOptions;
  private readonly database?: Database;
  private readonly ignoreRules?: IgnoreRuleSet;

  constructor(
    private readonly source: Mwn,
    private readonly target: Mwn,
    deps: PageSyncerDependencies = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
    this.database = deps.database;
    this.ignoreRules = deps.ignoreRules;
  }

  // ---------------------------------------------------------------- 数据库
  /** 带重试的数据库操作 */
  private retryDb<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      attempts: this.options.dbRetryMax,
      delayMs: this.options.dbRetryDelay,
      onRetry: (error, attempt, attempts) =>
        logger.debug(
          `数据库操作失败，正在重试 (${attempt}/${attempts}): ${getErrorMessage(error)}`,
        ),
    });
  }

  /** 若数据库中不存在该页面，先写入基本数据（含拼音索引） */
  async ensurePage(pageId: number, title: string): Promise<void> {
    const database = this.database;
    if (!database) return;
    // 没有 pageid 的（极少数脏数据）不写入，避免主键 0 冲突
    if (!pageId || pageId <= 0) return;

    try {
      await this.retryDb(async () => {
        const existing = await database.get("wikipages", { title });
        if (existing.length > 0) return;

        const { pinyin_full, pinyin_first } = generatePinyinInfo(title);
        // 页面改名后 pageid 不变：先按主键找一次，直接改标题，
        // 免得走 create 撞 UNIQUE 让驱动打一条吓人的报错日志
        const byId = await database.get("wikipages", { id: pageId });
        if (byId.length > 0) {
          await database.set(
            "wikipages",
            { id: pageId },
            { title, pinyin_full, pinyin_first },
          );
          logger.debug(`[数据库初始化] ♻️ 页面 ${title} 已按 pageid 更新标题`);
          return;
        }

        try {
          await database.create("wikipages", {
            id: pageId,
            title,
            pinyin_full,
            pinyin_first,
          });
          logger.debug(`[数据库初始化] ✅ 页面 ${title} 已添加到数据库`);
        } catch (err) {
          // 兜底：上面两次查询之间被并发写入抢了主键
          await database.set(
            "wikipages",
            { id: pageId },
            { title, pinyin_full, pinyin_first },
          );
          logger.debug(`[数据库初始化] ♻️ 页面 ${title} 已按 pageid 更新标题`);
        }
      });
    } catch (err) {
      logger.warn(
        `[数据库初始化] ❌ 初始化页面 ${title} 失败: ${getErrorMessage(err)}`,
      );
    }
  }

  /** 更新页面贡献者信息到数据库 */
  async updateContributor(
    title: string,
    user: string,
    timestamp: string,
  ): Promise<void> {
    const database = this.database;
    if (!database) return;

    try {
      await this.retryDb(async () => {
        await database.set(
          "wikipages",
          { title },
          {
            contributor: user,
            change_time: formatWikiTime(timestamp),
          },
        );
        logger.debug(
          `[数据库更新] ✅ 页面 ${title} 的贡献者信息已更新: ${user}`,
        );
      });
    } catch (err) {
      logger.warn(
        `[数据库更新] ❌ 更新页面 ${title} 的贡献者信息失败: ${getErrorMessage(err)}`,
      );
    }
  }

  // ------------------------------------------------------------ 单页 / 全量

  async syncOne(pageTitle: string, user: string): Promise<PageSyncResult> {
    const ignore = decideIgnore(
      this.ignoreRules,
      "page",
      pageTitle,
      this.options.ignoredPages.has(pageTitle),
    );
    if (ignore.ignored) {
      logger.debug(`[syncSinglePage] 🚫 页面 ${pageTitle} 跳过：${ignore.message}`);
      return { success: true, reason: "ignored", detail: ignore.message };
    }

    try {
      logger.debug(`[syncSinglePage] 🚀 开始同步页面: ${pageTitle}`);

      const [oldContent, newContent] = await Promise.all([
        getAndProcessPageContent(this.source, pageTitle),
        getAndProcessPageContent(this.target, pageTitle),
      ]);

      if (oldContent === newContent) {
        logger.debug(`[syncSinglePage] 🟡 页面 ${pageTitle} 内容未改变，跳过`);
        return { success: true, reason: "no_change" };
      }

      await this.target.save(
        pageTitle,
        oldContent,
        `由：${user} 触发更改，此时同步`,
      );
      logger.debug(`[syncSinglePage] ✅ 页面 ${pageTitle} 同步成功`);
      return { success: true, reason: "synced" };
    } catch (error) {
      const errMsg = getErrorMessage(error);
      logger.debug(`[syncSinglePage] ❌ 页面 ${pageTitle} 同步失败: ${errMsg}`);
      return { success: false, reason: errMsg };
    }
  }

  async listAll(hooks: SyncLoopHooks = {}): Promise<string[]> {
    hooks.log?.(
      "info",
      `[SyncAllPages] 📥 开始获取原站点所有页面（命名空间${this.options.namespace}）`,
    );

    const allPages: string[] = [];
    const queryGen = this.source.continuedQueryGen({
      action: "query",
      list: "allpages",
      apnamespace: this.options.namespace,
      aplimit: this.options.batchLimit,
      apdir: "ascending",
    });

    for await (const res of queryGen) {
      const pageTitles =
        res.query?.allpages?.map((page: { title: string }) => page.title) || [];
      allPages.push(...pageTitles);
      logger.debug(`[SyncAllPages] 📄 已获取 ${allPages.length} 个页面`);
    }

    hooks.log?.(
      "info",
      `[SyncAllPages] 📊 原站点总计获取到 ${allPages.length} 个页面`,
    );
    return allPages;
  }

  /** 处理单个页面并维护计数：三态判定来自领域层，这里只负责计数与节流 */
  private async processPageWithStats(
    pageTitle: string,
    user: string,
    stats: SyncStats,
    failedPages: string[],
    hooks: SyncLoopHooks,
    tag?: string,
  ): Promise<void> {
    const outcome = reportSyncItem(
      hooks,
      pageTitle,
      await this.syncOne(pageTitle, user),
      tag,
    );

    if (outcome.action === "failed") {
      stats.failCount++;
      failedPages.push(pageTitle);
      await sleep(this.options.intervalFailed);
      return;
    }

    stats.successCount++;
    if (outcome.action === "skipped") stats.skipCount++;
    await sleep(this.options.intervalSuccess);
  }

  private reportFinalReport(
    hooks: SyncLoopHooks,
    total: number,
    stats: SyncStats,
    stillFailed: string[],
  ): void {
    hooks.log?.(
      "info",
      `[SyncAllPages] 🎯 同步结束：总计 ${total} 个页面，成功 ${stats.successCount}（含跳过 ${stats.skipCount}），失败 ${stillFailed.length}`,
    );
    if (stillFailed.length > 0) {
      hooks.log?.(
        "warn",
        `❌ 重试后仍失败：${stillFailed.slice(0, 20).join("、")}` +
          (stillFailed.length > 20 ? ` 等 ${stillFailed.length} 个` : ""),
      );
    }
  }

  /** 全量同步所有页面：先串行同步一轮，再重试失败的 */
  async syncAll(hooks: SyncLoopHooks = {}): Promise<SyncLoopResult> {
    const emit = (info: Partial<SyncLoopProgress>) =>
      hooks.onProgress?.({
        phase: "同步页面",
        current: 0,
        total: 0,
        synced: 0,
        skipped: 0,
        failed: 0,
        ...info,
      });

    try {
      emit({ phase: "列举页面" });
      const oldPageList = await this.listAll(hooks);
      const total = oldPageList.length;

      if (total === 0) {
        hooks.log?.("info", `[SyncAllPages] 📭 原站点无页面可同步，结束`);
        return { total: 0, synced: 0, skipped: 0, failed: 0 };
      }

      const stats: SyncStats = {
        successCount: 0,
        failCount: 0,
        skipCount: 0,
      };
      const failedPages: string[] = [];

      hooks.log?.("info", `[SyncAllPages] 🚦 开始批量同步，总计 ${total} 个页面`);

      // 第一轮同步
      for (let index = 0; index < total; index++) {
        await hooks.checkpoint?.();
        const pageTitle = oldPageList[index];
        await this.processPageWithStats(
          pageTitle,
          this.options.defaultUser,
          stats,
          failedPages,
          hooks,
        );
        emit({
          current: index + 1,
          total,
          title: pageTitle,
          synced: stats.successCount - stats.skipCount,
          skipped: stats.skipCount,
          failed: stats.failCount,
        });
      }

      // 第二轮重试
      const stillFailed: string[] = [];
      if (failedPages.length > 0) {
        hooks.log?.(
          "warn",
          `[SyncAllPages] 🔄 开始重试 ${failedPages.length} 个失败页面`,
        );

        for (const pageTitle of failedPages) {
          await hooks.checkpoint?.();
          const outcome = reportSyncItem(
            hooks,
            pageTitle,
            await this.syncOne(pageTitle, this.options.defaultUser),
            "🔁 重试",
          );

          if (outcome.action === "failed") {
            stillFailed.push(pageTitle);
            await sleep(this.options.intervalFailed);
            continue;
          }

          stats.successCount++;
          stats.failCount--;
          if (outcome.action === "skipped") stats.skipCount++;
          await sleep(this.options.intervalSuccess);
        }
      }

      this.reportFinalReport(hooks, total, stats, stillFailed);
      return {
        total,
        synced: stats.successCount - stats.skipCount,
        skipped: stats.skipCount,
        failed: stillFailed.length,
      };
    } catch (globalError) {
      // 主动停止（SyncAbortedError）不算异常，交给上层判定
      if (globalError instanceof Error && globalError.name === ABORT_ERROR_NAME) {
        throw globalError;
      }
      logger.error(`[SyncAllPages] 💥 批量同步流程异常终止:`, globalError);
      throw globalError;
    }
  }
}
