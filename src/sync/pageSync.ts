import { Mwn } from "mwn";
import { getAndProcessPageContent } from "../utils/tools";
import { sleep } from "koishi";

export const CONFIG = {
  IGNORED_PAGES: ["教程", "MediaWiki:Common.css"], // 忽略的页面列表
  SYNC_INTERVAL_SUCCESS: 500, // 成功后等待时间(ms)
  SYNC_INTERVAL_FAILED: 1000, // 失败后等待时间(ms)
  NAMESPACE: 0, // 同步主命名空间
  BATCH_LIMIT: "max", // API单次请求最大数量
};

/**
 * 单页同步
 * @param oldSite 原站点机器人实例
 * @param newSite 新站点机器人实例
 * @param pageTitle 页面标题
 * @param user 触发同步的用户（用于编辑摘要，暂时不使用原站点）
 * @returns
 */
async function syncSinglePage(
  oldSite: Mwn,
  newSite: Mwn,
  pageTitle: string,
  user: string,
): Promise<{ success: boolean; reason?: string }> {
  if (CONFIG.IGNORED_PAGES.includes(pageTitle)) {
    console.log(`[Sync] 🚫 页面 ${pageTitle} 在忽略列表中，跳过`);
    return { success: true, reason: "ignored" };
  }

  try {
    console.log(`[Sync] 🚀 开始同步页面: ${pageTitle}`);
    // 获取页面内容
    const [oldContent, newContent] = await Promise.all([
      getAndProcessPageContent(oldSite, pageTitle),
      getAndProcessPageContent(newSite, pageTitle),
    ]);

    if (oldContent === newContent) {
      console.log(`[Sync] 🟡 页面 ${pageTitle} 内容未改变，跳过`);
      return { success: true, reason: "no_change" };
    }
    await newSite.save(pageTitle, oldContent, `由：${user} 触发更改，此时同步`);

    console.log(`[Sync] ✅ 页面 ${pageTitle} 同步成功`);
    return { success: true, reason: "synced" };
  } catch (error) {
    const errMsg = (error as Error).message || String(error);
    console.error(`[Sync] ❌ 页面 ${pageTitle} 同步失败:`, errMsg);
    return { success: false, reason: errMsg };
  }
}

/**
 * 获取站点所有页面
 * @param site Mwn实例
 * @returns 页面标题列表
 */
async function getAllPages(site: Mwn): Promise<string[]> {
  console.log(
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
    const pageTitles =
      res.query?.allpages?.map((page: any) => page.title) || [];
    allPages.push(...pageTitles);
    console.log(`[SyncAllPages] 📄 已获取 ${allPages.length} 个页面`);
  }

  console.log(`[SyncAllPages] 📊 原站点总计获取到 ${allPages.length} 个页面`);
  return allPages;
}

/**
 * 批量同步所有页面
 * @param oldSite 原站点实例
 * @param newSite 新站点实例
 * @returns
 */
async function syncPages(oldSite: Mwn, newSite: Mwn): Promise<void> {
  try {
    // 获取原站点所有页面
    const oldPageList = await getAllPages(oldSite);
    const total = oldPageList.length;

    if (total === 0) {
      console.log(`[SyncAllPages] 📭 原站点无页面可同步，结束`);
      return;
    }

    // 初始化统计信息
    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;
    const failedPages: string[] = []; // 用于记录第一轮失败的页面

    console.log(`[SyncAllPages] 🚦 开始批量同步，总计 ${total} 个页面`);

    // 第一轮：串行同步每个页面
    for (let index = 0; index < total; index++) {
      const pageTitle = oldPageList[index];
      const current = index + 1;
      const remaining = total - current;
      const progress = ((current / total) * 100).toFixed(1);

      console.log(
        `\n[SyncAllPages] 📈 进度 [${current}/${total}] (${progress}%) - 处理 ${pageTitle} | 剩余 ${remaining} 个`,
      );

      // 执行单页同步
      const syncResult = await syncSinglePage(
        oldSite,
        newSite,
        pageTitle,
        "同步坤器人",
      );

      // 更新统计
      if (!syncResult.success) {
        failCount++;
        failedPages.push(pageTitle); // 记录失败的标题
        await sleep(CONFIG.SYNC_INTERVAL_FAILED);
      } else {
        successCount++;
        if (
          syncResult.reason === "ignored" ||
          syncResult.reason === "no_change"
        ) {
          skipCount++;
        }
        await sleep(CONFIG.SYNC_INTERVAL_SUCCESS);
      }
    }

    // 第二轮：重试失败的页面
    if (failedPages.length > 0) {
      console.log(
        `\n[SyncAllPages] 🔄 ===== 开始重试 ${failedPages.length} 个失败页面 =====`,
      );

      const stillFailed: string[] = [];

      for (const pageTitle of failedPages) {
        console.log(`\n[SyncAllPages] 🔁 重试中: ${pageTitle}`);

        const syncResult = await syncSinglePage(
          oldSite,
          newSite,
          pageTitle,
          "同步坤器人",
        );

        if (syncResult.success) {
          successCount++;
          failCount--; // 修正统计数据
          if (
            syncResult.reason === "ignored" ||
            syncResult.reason === "no_change"
          ) {
            skipCount++;
          }
          console.log(`[SyncAllPages] ✅ 页面 ${pageTitle} 重试成功`);
          await sleep(CONFIG.SYNC_INTERVAL_SUCCESS);
        } else {
          stillFailed.push(pageTitle);
          console.log(`[SyncAllPages] ❌ 页面 ${pageTitle} 再次失败`);
          await sleep(CONFIG.SYNC_INTERVAL_FAILED);
        }
      }

      // 最终汇总报告
      console.log(`\n[SyncAllPages] 📋 ===== 最终同步报告 =====`);
      if (stillFailed.length > 0) {
        console.log(`❌ 以下页面经过重试仍然失败，请手动检查：`);
        stillFailed.forEach((title, idx) => {
          console.log(`  ${idx + 1}. ${title}`);
        });
      } else {
        console.log(`🎉 所有页面同步成功（含重试）！`);
      }
    }

    // 汇总结果
    console.log(`\n[SyncAllPages] 🎯 同步流程结束！`);
    console.log(`├─ 总计：${total} 个页面`);
    console.log(`├─ 成功：${successCount} 个（含跳过 ${skipCount} 个）`);
    console.log(`└─ 失败：${failCount} 个`);
  } catch (globalError) {
    console.error(`[SyncAllPages] 💥 批量同步流程异常终止:`, globalError);
    throw globalError; // 抛出错误让上层处理
  }
}

export { syncSinglePage, syncPages };
