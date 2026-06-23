import { Mwn } from "mwn";
import { Config } from "../index";
import {
  getAndProcessPageContent,
  logger,
  formatWikiTime,
  generatePinyinInfo,
} from "../utils/tools";
import { sleep } from "koishi";
import { syncSingleImage } from "./imgSync";

const CONFIG = {
  IGNORED_PAGES: new Set(["教程", "MediaWiki:Common.css", "首页", "Main Page"]),
  SYNC_INTERVAL_SUCCESS: 500,
  SYNC_INTERVAL_FAILED: 1000,
  NAMESPACE: 0,
  BATCH_LIMIT: "max" as const,
  FILE_NAMESPACE_PREFIX: "File:",
  DEFAULT_USER: "同步坤器人",
  INCREMENTAL_USER: "定时同步",
  DB_RETRY_MAX: 3,
  DB_RETRY_DELAY: 500,
};

export interface Database {
  set(table: string, query: object, data: object): Promise<any>;
  get<T = any>(table: string, query: object): Promise<T[]>;
  create(table: string, data: object): Promise<any>;
  upsert(table: string, data: object | object[]): Promise<any>;
}

interface RecentChange {
  title: string;
  user?: string;
  timestamp?: string;
  comment?: string;
  rcid: number;
  pageid?: number;
}

/**
 * 带重试的数据库操作
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = CONFIG.DB_RETRY_MAX,
  delay: number = CONFIG.DB_RETRY_DELAY,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        logger.debug(
          `数据库操作失败，正在重试 (${attempt}/${maxRetries}): ${lastError.message}`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error("数据库操作失败");
}

/**
 * 检查并初始化页面到数据库
 * 如果数据库中不存在该页面，先创建基本数据
 */
export async function ensurePageInDatabase(
  database: Database | undefined,
  pageId: number,
  title: string,
): Promise<void> {
  if (!database) return;

  try {
    await withRetry(async () => {
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
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`[数据库初始化] ❌ 初始化页面 ${title} 失败: ${errMsg}`);
  }
}

/**
 * 更新页面贡献者信息到数据库
 */
export async function updateContributorToDatabase(
  database: Database | undefined,
  title: string,
  user: string,
  timestamp: string,
): Promise<void> {
  if (!database) return;

  try {
    await withRetry(async () => {
      await database.set(
        "wikipages",
        { title },
        {
          contributor: user,
          change_time: formatWikiTime(timestamp),
        },
      );
      logger.debug(`[数据库更新] ✅ 页面 ${title} 的贡献者信息已更新: ${user}`);
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[数据库更新] ❌ 更新页面 ${title} 的贡献者信息失败: ${errMsg}`,
    );
  }
}
/**
 * 单页面同步
 * @param oldSite 源站点机器人实例
 * @param newSite 目标站点机器人实例
 * @param pageTitle 同步的标题
 * @param user 触发更改的用户
 * @returns success: boolean;reason: string;
}
 */
async function syncSinglePage(
  oldSite: Mwn,
  newSite: Mwn,
  pageTitle: string,
  user: string,
): Promise<{
  success: boolean;
  reason: string;
}> {
  if (CONFIG.IGNORED_PAGES.has(pageTitle)) {
    logger.info(`[syncSinglePage] 🚫 页面 ${pageTitle} 在忽略列表中，跳过`);
    return { success: true, reason: "ignored" };
  }

  try {
    logger.info(`[syncSinglePage] 🚀 开始同步页面: ${pageTitle}`);

    const [oldContent, newContent] = await Promise.all([
      getAndProcessPageContent(oldSite, pageTitle),
      getAndProcessPageContent(newSite, pageTitle),
    ]);

    if (oldContent === newContent) {
      logger.info(`[syncSinglePage] 🟡 页面 ${pageTitle} 内容未改变，跳过`);
      return { success: true, reason: "no_change" };
    }

    await newSite.save(pageTitle, oldContent, `由：${user} 触发更改，此时同步`);
    logger.info(`[syncSinglePage] ✅ 页面 ${pageTitle} 同步成功`);
    return { success: true, reason: "synced" };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`[syncSinglePage] ❌ 页面 ${pageTitle} 同步失败:`, errMsg);
    return { success: false, reason: errMsg };
  }
}

/**
 * 获取站点所有页面
 * @param site 站点名称
 * @returns 页面名称列表
 */
async function getAllPages(site: Mwn): Promise<string[]> {
  logger.info(
    `[SyncAllPages] 📥 开始获取原站点所有页面（命名空间${CONFIG.NAMESPACE}）`,
  );

  const allPages: string[] = [];
  const queryGen = site.continuedQueryGen({
    action: "query",
    list: "allpages",
    apnamespace: CONFIG.NAMESPACE,
    aplimit: CONFIG.BATCH_LIMIT,
    apdir: "ascending",
  });

  for await (const res of queryGen) {
    const pageTitles = res.query?.allpages?.map((page) => page.title) || [];
    allPages.push(...pageTitles);
    logger.info(`[SyncAllPages] 📄 已获取 ${allPages.length} 个页面`);
  }

  logger.info(`[SyncAllPages] 📊 原站点总计获取到 ${allPages.length} 个页面`);
  return allPages;
}

// 处理页面与统计数据
async function processPageWithStats(
  oldSite: Mwn,
  newSite: Mwn,
  pageTitle: string,
  user: string,
  stats: { successCount: number; failCount: number; skipCount: number },
  failedPages: string[],
): Promise<void> {
  const syncResult = await syncSinglePage(oldSite, newSite, pageTitle, user);

  if (!syncResult.success) {
    stats.failCount++;
    failedPages.push(pageTitle);
    await sleep(CONFIG.SYNC_INTERVAL_FAILED);
  } else {
    stats.successCount++;
    if (syncResult.reason === "ignored" || syncResult.reason === "no_change") {
      stats.skipCount++;
    }
    await sleep(CONFIG.SYNC_INTERVAL_SUCCESS);
  }
}

function printProgress(
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

function printFinalReport(
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

/**
 * 同步所有页面
 * @param oldSite 源站点机器人实例
 * @param newSite 目标站点机器人实例
 * @returns null
 */
async function syncPages(oldSite: Mwn, newSite: Mwn): Promise<void> {
  try {
    const oldPageList = await getAllPages(oldSite);
    const total = oldPageList.length;

    if (total === 0) {
      logger.info(`[SyncAllPages] 📭 原站点无页面可同步，结束`);
      return;
    }

    const stats = { successCount: 0, failCount: 0, skipCount: 0 };
    const failedPages: string[] = [];

    logger.info(`[SyncAllPages] 🚦 开始批量同步，总计 ${total} 个页面`);

    // 第一轮同步
    for (let index = 0; index < total; index++) {
      const pageTitle = oldPageList[index];
      printProgress(index + 1, total, pageTitle);
      await processPageWithStats(
        oldSite,
        newSite,
        pageTitle,
        CONFIG.DEFAULT_USER,
        stats,
        failedPages,
      );
    }

    // 第二轮重试
    let stillFailed: string[] = [];
    if (failedPages.length > 0) {
      logger.info(
        `\n[SyncAllPages] 🔄 ===== 开始重试 ${failedPages.length} 个失败页面 =====`,
      );

      for (const pageTitle of failedPages) {
        logger.info(`\n[SyncAllPages] 🔁 重试中: ${pageTitle}`);
        const syncResult = await syncSinglePage(
          oldSite,
          newSite,
          pageTitle,
          CONFIG.DEFAULT_USER,
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
          await sleep(CONFIG.SYNC_INTERVAL_SUCCESS);
        } else {
          stillFailed.push(pageTitle);
          logger.info(`[SyncAllPages] ❌ 页面 ${pageTitle} 再次失败`);
          await sleep(CONFIG.SYNC_INTERVAL_FAILED);
        }
      }
    }

    printFinalReport(
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

/**
 * 同步成功事件信息
 */
export interface SyncNotifyItem {
  title: string;
  type: "page" | "image";
  user?: string;
  timestamp?: string;
  comment?: string;
}

/**
 * 增量更新
 * @param oldSite 源站点机器人实例
 * @param newSite 目标站点机器人实例
 * @param config KOISHI用户配置的项
 * @param onSynced 同步成功批量回调（仅 reason==="synced" 的条目，函数结束时一次调用）
 * @param database 数据库实例（可选），用于更新贡献者信息
 */
export async function incrementalUpdate(
  oldSite: Mwn,
  newSite: Mwn,
  config: Config,
  onSynced?: (items: SyncNotifyItem[]) => void,
  database?: Database,
): Promise<void> {
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

    const queryGen = oldSite.continuedQueryGen({
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
        if (CONFIG.IGNORED_PAGES.has(title)) {
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
          if (title.startsWith(CONFIG.FILE_NAMESPACE_PREFIX)) {
            await handleImageSync(
              oldSite,
              newSite,
              title,
              user,
              timestamp,
              comment,
              config,
              syncedItems,
            );
          } else {
            // 普通页面更新
            await handlePageSync(
              oldSite,
              newSite,
              title,
              pageid || 0,
              user,
              timestamp,
              comment,
              database,
              syncedItems,
            );
            totalSynced++;
          }

          await sleep(CONFIG.SYNC_INTERVAL_SUCCESS);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.error(`[增量更新流程] ❌ 处理 ${title} 时出错:`, errMsg);
          await sleep(CONFIG.SYNC_INTERVAL_FAILED);
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
      onSynced?.(syncedItems);
    }
  }
}

/**
 * 处理图片同步
 */
async function handleImageSync(
  oldSite: Mwn,
  newSite: Mwn,
  title: string,
  user: string,
  timestamp: string,
  comment: string,
  config: Config,
  syncedItems: SyncNotifyItem[],
): Promise<void> {
  const fileName = title.replace(CONFIG.FILE_NAMESPACE_PREFIX, "");
  logger.info(`[增量更新流程] 🖼️ 检查到图片: ${title}，正在尝试转存`);
  const result = await syncSingleImage(oldSite, newSite, fileName, config);
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

/**
 * 处理页面同步
 */
async function handlePageSync(
  oldSite: Mwn,
  newSite: Mwn,
  title: string,
  pageId: number,
  user: string,
  timestamp: string,
  comment: string,
  database: Database | undefined,
  syncedItems: SyncNotifyItem[],
): Promise<void> {
  // 先检查数据库中是否存在该页面，不存在则先创建
  await ensurePageInDatabase(database, pageId, title);

  const result = await syncSinglePage(oldSite, newSite, title, user);
  if (result.success && result.reason === "synced") {
    syncedItems.push({
      title,
      type: "page",
      user,
      timestamp,
      comment,
    });

    // 更新数据库中的贡献者信息
    await updateContributorToDatabase(database, title, user, timestamp);
  }
}

export { syncSinglePage, syncPages };
