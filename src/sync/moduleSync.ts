import { Mwn } from "mwn";
import { getAndProcessPageContent, logger } from "../utils/tools";
import { sleep } from "koishi";

const CONFIG = {
  MODLE_NAMESPACE: 828, // 模块命名空间 (注意：这里原代码拼写为 MODLE，保留原样)
  IGNORED_MODULES: [], // 忽略的模块列表
  SYNC_INTERVAL_SUCCESS: 500, // 同步成功后等待时间（毫秒）
  SYNC_INTERVAL_FAILED: 1000, // 同步失败后等待时间（毫秒）
};

/**
 * 同步单个模块
 * @param oldSite 原站点
 * @param newSite 新站点
 * @param moduleTitle 模块标题
 * @param user 触发同步的用户
 * @returns
 */
async function syncSingleModule(
  oldSite: Mwn,
  newSite: Mwn,
  moduleTitle: string,
  user?: string,
): Promise<{ success: boolean; reason?: string }> {
  if (CONFIG.IGNORED_MODULES.includes(moduleTitle)) {
    logger.info(`[SyncModule] 🚫 模块 ${moduleTitle} 在忽略列表中，跳过`);
    return { success: true, reason: "ignored" };
  }
  try {
    logger.info(`[SyncModule] 🔍 开始获取模块 ${moduleTitle} 的内容`);
    let targetTitle = moduleTitle;
    if (/^Dev:/i.test(moduleTitle)) {
      // 截取 "Dev:" 后面的部分
      // 例如 "Dev:Arguments" -> "Arguments"
      const subPageName = moduleTitle.replace(/^Dev:/i, "");

      // 拼接成新的目标标题
      // 例如 "Arguments" -> "Module:Dev/Arguments"
      targetTitle = `Module:Dev/${subPageName}`;

      logger.info(
        `[SyncModule] 🔀 检测到 Dev 命名空间，路径映射: ${moduleTitle} -> ${targetTitle}`,
      );
    }
    // 获取模块内容
    const [oldContent, newContent] = await Promise.all([
      getAndProcessPageContent(oldSite, moduleTitle),
      getAndProcessPageContent(newSite, targetTitle),
    ]);
    if (oldContent === newContent) {
      logger.info(`[SyncModule] 🟡 模块 ${moduleTitle} 内容未改变，跳过`);
      return { success: true, reason: "no_change" };
    }
    await newSite.save(
      targetTitle,
      oldContent,
      `由：${user || "同步坤器人手动"} 触发更改，此时同步`,
    );

    logger.info(`[SyncModule] ✅ 模块 ${moduleTitle} 同步成功`);
    return { success: true, reason: "synced" };
  } catch (error) {
    const errMsg = (error as Error).message || String(error);
    logger.error(`[SyncModule] ❌ 模块 ${moduleTitle} 同步失败:`, errMsg);
    return { success: false, reason: errMsg };
  }
}

/**
 * 获取原站点所有模块
 * @param site 原站点
 * @returns 模块标题数组
 */
async function getAllModules(site: Mwn): Promise<string[]> {
  logger.info(
    `[SyncAllModules] 📥 开始获取原站点所有模块（命名空间${CONFIG.MODLE_NAMESPACE}）`,
  );
  const allModules: string[] = [];
  const queryGen = site.continuedQueryGen({
    action: "query",
    list: "allpages",
    apnamespace: CONFIG.MODLE_NAMESPACE, // 模块命名空间
    aplimit: "max",
    apdir: "ascending",
  });
  for await (const res of queryGen) {
    const moduleTitles =
      res.query?.allpages?.map((page: any) => page.title) || [];
    allModules.push(...moduleTitles);
    logger.info(`[SyncAllModules] 📄 已获取 ${allModules.length} 个模块`);
  }
  logger.info(
    `[SyncAllModules] 📊 原站点总计获取到 ${allModules.length} 个模块`,
  );
  return allModules;
}

/**
 * 批量同步所有模块
 * @param oldSite 原站点
 * @param newSite 新站点
 * @returns
 */
async function syncModules(oldSite: Mwn, newSite: Mwn): Promise<void> {
  try {
    // 获取原站点所有页面
    const oldModuleList = await getAllModules(oldSite);
    const total = oldModuleList.length;
    console.log(oldModuleList);
    if (total === 0) {
      logger.info(`[SyncAllModules] 📭 原站点无模块可同步，结束`);
      return;
    }
    // 初始化统计信息
    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;
    const failedModules: string[] = []; // 记录第一轮失败的模块

    logger.info(`[SyncAllModules] 🚦 开始批量同步，总计 ${total} 个模块`);

    // 第一轮：串行同步每个模块
    for (let index = 0; index < total; index++) {
      const moduleTitle = oldModuleList[index];
      const current = index + 1;
      const remaining = total - current;
      const progress = ((current / total) * 100).toFixed(1);

      logger.info(
        `\n[SyncAllModules] 📈 进度 [${current}/${total}] (${progress}%) - 处理 ${moduleTitle} | 剩余 ${remaining} 个`,
      );
      // 执行单模块同步
      const syncResult = await syncSingleModule(
        oldSite,
        newSite,
        moduleTitle,
        "同步坤器人",
      );
      // 更新统计
      if (!syncResult.success) {
        failCount++;
        failedModules.push(moduleTitle); // 记录失败标题
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

    // 第二轮：重试失败的模块
    if (failedModules.length > 0) {
      logger.info(
        `\n[SyncAllModules] 🔄 ===== 开始重试 ${failedModules.length} 个失败模块 =====`,
      );

      const stillFailed: string[] = [];

      for (const moduleTitle of failedModules) {
        logger.info(`\n[SyncAllModules] 🔁 重试中: ${moduleTitle}`);

        const syncResult = await syncSingleModule(
          oldSite,
          newSite,
          moduleTitle,
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
          logger.info(`[SyncAllModules] ✅ 模块 ${moduleTitle} 重试成功`);
          await sleep(CONFIG.SYNC_INTERVAL_SUCCESS);
        } else {
          stillFailed.push(moduleTitle);
          logger.info(`[SyncAllModules] ❌ 模块 ${moduleTitle} 再次失败`);
          await sleep(CONFIG.SYNC_INTERVAL_FAILED);
        }
      }

      // 最终汇总报告
      logger.info(`\n[SyncAllModules] 📋 ===== 最终同步报告 =====`);
      if (stillFailed.length > 0) {
        logger.info(`❌ 以下模块经过重试仍然失败，请手动检查：`);
        stillFailed.forEach((title, idx) => {
          logger.info(`  ${idx + 1}. ${title}`);
        });
      } else {
        logger.info(`🎉 所有模块同步成功（含重试）！`);
      }
    }

    // 汇总结果
    logger.info(`\n[SyncAllModules] 🎯 同步完成！`);
    logger.info(`├─ 总计：${total} 个模块`);
    logger.info(`├─ 成功：${successCount} 个（含跳过 ${skipCount} 个）`);
    logger.info(`└─ 失败：${failCount} 个`);
  } catch (error) {
    logger.error(`[SyncAllModules] 💥 批量同步流程异常终止:`, error);
    throw error; // 抛出错误让上层处理
  }
}
export { syncSingleModule, syncModules };
