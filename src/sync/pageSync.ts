import { Mwn } from "mwn";
import {
  getAndProcessPageContent,
  logger,
  formatWikiTime,
  generatePinyinInfo,
  getErrorMessage,
} from "../utils/tools";
import { sleep, withRetry } from "../utils/async";
import { ImageSyncer } from "./imgSync";

/**
 * pageSync 需要的数据库能力（结构化的最小接口）。
 *
 * 说明：`wikipages` 已经通过 `src/plugins/databaseExtension.ts` 里的 `Tables`
 * 接口增强声明过，但 `onitodos` 没有。这里刻意保留最小接口，避免与 Koishi
 * 的表类型强耦合。`get<T = unknown>` 是唯一保留的宽松点。
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

interface RecentChange {
  title: string;
  user?: string;
  timestamp?: string;
  comment?: string;
  rcid: number;
  pageid?: number;
}

export interface PageSyncResult {
  success: boolean;
  reason: string;
}

interface SyncStats {
  successCount: number;
  failCount: number;
  skipCount: number;
}

export interface PageSyncerDependencies {
  /** 数据库实例（可选），用于维护 wikipages 表 */
  database?: Database;
  /** 增量更新结束时一次性回调（仅包含 reason==="synced" 的条目） */
  notify?: (items: SyncNotifyItem[]) => void;
  /**
   * 单页同步成功（reason==="synced"）后的回调。
   *
   * 用于「同步完再抽取渲染文本 / 更新向量库」这类后续步骤；
   * 回调抛错不会影响同步本身的成败。
   */
  onSynced?: (title: string) => void | Promise<void>;
  options?: Partial<PageSyncOptions>;
}

/**
 * 负责页面层面的同步：单页同步、全量同步、以及定时的增量更新。
 *
 * 依赖（源站 / 目标站 / 数据库 / 通知回调 / 选项）全部由构造函数注入，
 * 不再依赖模块级可变单例；图片同步通过组合 `ImageSyncer` 复用。
 */
export class PageSyncer {
  private readonly options: PageSyncOptions;
  private readonly database?: Database;
  private readonly notify?: (items: SyncNotifyItem[]) => void;
  private readonly onSynced?: (title: string) => void | Promise<void>;
  private readonly images: ImageSyncer;

  constructor(
    private readonly source: Mwn,
    private readonly target: Mwn,
    deps: PageSyncerDependencies = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
    this.database = deps.database;
    this.notify = deps.notify;
    this.onSynced = deps.onSynced;
    this.images = new ImageSyncer(source, target);
  }

  /** 同步成功后的后续处理；失败只记日志，绝不影响同步结果 */
  private async runSyncedHook(title: string): Promise<void> {
    if (!this.onSynced) return;
    try {
      await this.onSynced(title);
    } catch (error) {
      logger.warn(
        `[syncSinglePage] 页面 ${title} 的同步后处理失败: ${getErrorMessage(error)}`,
      );
    }
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
  private async ensurePageInDatabase(
    pageId: number,
    title: string,
  ): Promise<void> {
    const database = this.database;
    if (!database) return;

    try {
      await this.retryDb(async () => {
        const existing = await database.get("wikipages", { title });
        if (existing.length === 0) {
          const { pinyin_full, pinyin_first } = generatePinyinInfo(title);
          await database.create("wikipages", {
            id: pageId,
            title,
            pinyin_full,
            pinyin_first,
          });
          logger.info(`[数据库初始化] ✅ 页面 ${title} 已添加到数据库`);
        }
      });
    } catch (err) {
      logger.warn(
        `[数据库初始化] ❌ 初始化页面 ${title} 失败: ${getErrorMessage(err)}`,
      );
    }
  }

  /** 更新页面贡献者信息到数据库 */
  private async updateContributorToDatabase(
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
    if (this.options.ignoredPages.has(pageTitle)) {
      logger.info(`[syncSinglePage] 🚫 页面 ${pageTitle} 在忽略列表中，跳过`);
      return { success: true, reason: "ignored" };
    }

    try {
      logger.info(`[syncSinglePage] 🚀 开始同步页面: ${pageTitle}`);

      const [oldContent, newContent] = await Promise.all([
        getAndProcessPageContent(this.source, pageTitle),
        getAndProcessPageContent(this.target, pageTitle),
      ]);

      if (oldContent === newContent) {
        logger.info(`[syncSinglePage] 🟡 页面 ${pageTitle} 内容未改变，跳过`);
        return { success: true, reason: "no_change" };
      }

      await this.target.save(
        pageTitle,
        oldContent,
        `由：${user} 触发更改，此时同步`,
      );
      logger.info(`[syncSinglePage] ✅ 页面 ${pageTitle} 同步成功`);
      await this.runSyncedHook(pageTitle);
      return { success: true, reason: "synced" };
    } catch (error) {
      const errMsg = getErrorMessage(error);
      logger.error(`[syncSinglePage] ❌ 页面 ${pageTitle} 同步失败:`, errMsg);
      return { success: false, reason: errMsg };
    }
  }

  async listAll(): Promise<string[]> {
    logger.info(
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
      logger.info(`[SyncAllPages] 📄 已获取 ${allPages.length} 个页面`);
    }

    logger.info(`[SyncAllPages] 📊 原站点总计获取到 ${allPages.length} 个页面`);
    return allPages;
  }

  private async processPageWithStats(
    pageTitle: string,
    user: string,
    stats: SyncStats,
    failedPages: string[],
  ): Promise<void> {
    const syncResult = await this.syncOne(pageTitle, user);

    if (!syncResult.success) {
      stats.failCount++;
      failedPages.push(pageTitle);
      await sleep(this.options.intervalFailed);
    } else {
      stats.successCount++;
      if (
        syncResult.reason === "ignored" ||
        syncResult.reason === "no_change"
      ) {
        stats.skipCount++;
      }
      await sleep(this.options.intervalSuccess);
    }
  }

  private printProgress(
    current: number,
    total: number,
    pageTitle: string,
  ): void {
    const progress = ((current / total) * 100).toFixed(1);
    const remaining = total - current;
    logger.info(
      `\n[SyncAllPages] 📈 进度 [${current}/${total}] (${progress}%) - 处理 ${pageTitle} | 剩余 ${remaining} 个`,
    );
  }

  private printFinalReport(
    total: number,
    successCount: number,
    failCount: number,
    skipCount: number,
    stillFailed: string[],
  ): void {
    logger.info(`\n[SyncAllPages] 📋 ===== 最终同步报告 =====`);
    if (stillFailed.length > 0) {
      logger.info(`❌ 以下页面经过重试仍然失败，请手动检查：`);
      stillFailed.forEach((title, idx) => {
        logger.info(`  ${idx + 1}. ${title}`);
      });
    } else {
      logger.info(`🎉 所有页面同步成功（含重试）！`);
    }

    logger.info(`\n[SyncAllPages] 🎯 同步流程结束！`);
    logger.info(`├─ 总计：${total} 个页面`);
    logger.info(`├─ 成功：${successCount} 个（含跳过 ${skipCount} 个）`);
    logger.info(`└─ 失败：${failCount} 个`);
  }

  /** 全量同步所有页面：先串行同步一轮，再重试失败的 */
  async syncAll(): Promise<void> {
    try {
      const oldPageList = await this.listAll();
      const total = oldPageList.length;

      if (total === 0) {
        logger.info(`[SyncAllPages] 📭 原站点无页面可同步，结束`);
        return;
      }

      const stats: SyncStats = {
        successCount: 0,
        failCount: 0,
        skipCount: 0,
      };
      const failedPages: string[] = [];

      logger.info(`[SyncAllPages] 🚦 开始批量同步，总计 ${total} 个页面`);

      // 第一轮同步
      for (let index = 0; index < total; index++) {
        const pageTitle = oldPageList[index];
        this.printProgress(index + 1, total, pageTitle);
        await this.processPageWithStats(
          pageTitle,
          this.options.defaultUser,
          stats,
          failedPages,
        );
      }

      // 第二轮重试
      const stillFailed: string[] = [];
      if (failedPages.length > 0) {
        logger.info(
          `\n[SyncAllPages] 🔄 ===== 开始重试 ${failedPages.length} 个失败页面 =====`,
        );

        for (const pageTitle of failedPages) {
          logger.info(`\n[SyncAllPages] 🔁 重试中: ${pageTitle}`);
          const syncResult = await this.syncOne(
            pageTitle,
            this.options.defaultUser,
          );

          if (syncResult.success) {
            stats.successCount++;
            stats.failCount--;
            if (
              syncResult.reason === "ignored" ||
              syncResult.reason === "no_change"
            ) {
              stats.skipCount++;
            }
            logger.info(`[SyncAllPages] ✅ 页面 ${pageTitle} 重试成功`);
            await sleep(this.options.intervalSuccess);
          } else {
            stillFailed.push(pageTitle);
            logger.info(`[SyncAllPages] ❌ 页面 ${pageTitle} 再次失败`);
            await sleep(this.options.intervalFailed);
          }
        }
      }

      this.printFinalReport(
        total,
        stats.successCount,
        stats.failCount,
        stats.skipCount,
        stillFailed,
      );
    } catch (globalError) {
      logger.error(`[SyncAllPages] 💥 批量同步流程异常终止:`, globalError);
      throw globalError;
    }
  }

  // ---------------------------------------------------------------- 增量更新

  /**
   * 增量更新：取最近 3 小时的 recentchanges 并逐条同步。
   *
   * 结束时通过构造时注入的 `notify` 一次性回调成功条目
   * （仅 reason==="synced" 的页面与图片）。
   */
  async incrementalUpdate(): Promise<void> {
    const startTime = Date.now();
    const processedTitles = new Set<string>();
    const syncedItems: SyncNotifyItem[] = [];
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalSynced = 0;

    try {
      const now = new Date();
      const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
      logger.info(
        `[增量更新流程] ⏰ 开始处理 ${threeHoursAgo.toISOString()} 到 ${now.toISOString()} 的更新...`,
      );

      const queryGen = this.source.continuedQueryGen({
        action: "query",
        list: "recentchanges",
        rcstart: now.toISOString(),
        rcend: threeHoursAgo.toISOString(),
        rcdir: "older",
        rcprop: "user|comment|title|timestamp|ids",
      });

      for await (const res of queryGen) {
        const pages: RecentChange[] = res.query?.recentchanges || [];

        for (const page of pages) {
          const {
            title,
            user: rcUser,
            timestamp: rcTimestamp,
            comment: rcComment,
            pageid,
          } = page;

          // 检查是否已处理过
          if (processedTitles.has(title)) {
            logger.debug(`[增量更新流程] ⏭️ 已处理过 ${title}, 跳过`);
            totalSkipped++;
            continue;
          }

          // 检查是否在忽略列表中
          if (this.options.ignoredPages.has(title)) {
            logger.info(
              `[增量更新流程] 🚫 ${title} 在无需处理的页面列表中, 跳过`,
            );
            processedTitles.add(title);
            totalSkipped++;
            continue;
          }

          processedTitles.add(title);
          totalProcessed++;

          try {
            const user = rcUser || "未知";
            const timestamp = rcTimestamp || "";
            const comment = rcComment || "";

            // 检查是否为图片页面
            if (title.startsWith(this.options.fileNamespacePrefix)) {
              await this.handleImageSync(
                title,
                user,
                timestamp,
                comment,
                syncedItems,
              );
            } else {
              await this.handlePageSync(
                title,
                pageid || 0,
                user,
                timestamp,
                comment,
                syncedItems,
              );
              totalSynced++;
            }

            await sleep(this.options.intervalSuccess);
          } catch (error) {
            const errMsg = getErrorMessage(error);
            logger.error(`[增量更新流程] ❌ 处理 ${title} 时出错:`, errMsg);
            await sleep(this.options.intervalFailed);
          }
        }
      }
    } catch (globalError) {
      logger.error(`[增量更新流程] 💥 增量更新流程异常终止:`, globalError);
      throw globalError;
    } finally {
      const duration = (Date.now() - startTime) / 1000;
      logger.info(
        `[增量更新流程] ✅ 增量更新完成！处理: ${totalProcessed}, 跳过: ${totalSkipped}, 同步: ${totalSynced}, 通知: ${syncedItems.length}, 耗时: ${duration.toFixed(2)}s`,
      );
      if (syncedItems.length > 0) {
        this.notify?.(syncedItems);
      }
    }
  }

  /** 增量更新中遇到图片页面时的处理 */
  private async handleImageSync(
    title: string,
    user: string,
    timestamp: string,
    comment: string,
    syncedItems: SyncNotifyItem[],
  ): Promise<void> {
    const fileName = title.replace(this.options.fileNamespacePrefix, "");
    logger.info(`[增量更新流程] 🖼️ 检查到图片: ${title}，正在尝试转存`);

    const result = await this.images.syncOne(fileName);
    if (result.success && result.reason === "synced") {
      syncedItems.push({
        title,
        type: "image",
        user,
        timestamp,
        comment,
      });
    }
  }

  /** 增量更新中遇到普通页面时的处理 */
  private async handlePageSync(
    title: string,
    pageId: number,
    user: string,
    timestamp: string,
    comment: string,
    syncedItems: SyncNotifyItem[],
  ): Promise<void> {
    // 先检查数据库中是否存在该页面，不存在则先创建
    await this.ensurePageInDatabase(pageId, title);

    const result = await this.syncOne(title, user);
    if (result.success) {
      if (result.reason === "synced") {
        syncedItems.push({
          title,
          type: "page",
          user,
          timestamp,
          comment,
        });
      }

      // 更新贡献者信息（无论内容是否变化，只要有变更记录就更新）
      await this.updateContributorToDatabase(title, user, timestamp);
    }
  }
}
