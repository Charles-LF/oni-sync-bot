import { Mwn } from "mwn";
import { getAndProcessPageContent } from "../utils/tools";
import { sleep } from "koishi";
const CONFIG = {
  MODLE_NAMESPACE: 828, // 模块命名空间
  IGNORED_MODULES: [], // 忽略的模块列表
  SYNC_INTERVAL_SUCCESS: 1000, // 同步成功后等待时间（毫秒）
  SYNC_INTERVAL_FAILED: 2000, // 同步失败后等待时间（毫秒）
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
    console.log(`[SyncModule] 🚫 模块 ${moduleTitle} 在忽略列表中，跳过`);
    return { success: true, reason: "ignored" };
  }
  try {
    console.log(`[SyncModule] 🔍 开始获取模块 ${moduleTitle} 的内容`);
    // 获取模块内容
    const [oldContent, newContent] = await Promise.all([
      getAndProcessPageContent(oldSite, moduleTitle),
      getAndProcessPageContent(newSite, moduleTitle),
    ]);
    if (oldContent === newContent) {
      console.log(`[SyncModule] 🟡 模块 ${moduleTitle} 内容未改变，跳过`);
      return { success: true, reason: "no_change" };
    }
    await newSite.save(
      moduleTitle,
      oldContent,
      `由：${user || "同步坤器人手动"} 触发更改，此时同步`,
    );

    console.log(`[SyncModule] ✅ 模块 ${moduleTitle} 同步成功`);
    return { success: true, reason: "synced" };
  } catch (error) {
    const errMsg = (error as Error).message || String(error);
    console.error(`[SyncModule] ❌ 模块 ${moduleTitle} 同步失败:`, errMsg);
    return { success: false, reason: errMsg };
  }
}

/**
 * 获取原站点所有模块
 * @param site 原站点
 * @returns 模块标题数组
 */
async function getAllModules(site: Mwn): Promise<string[]> {
  console.log(
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
    console.log(`[SyncAllModules] 📄 已获取 ${allModules.length} 个模块`);
  }
  console.log(
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

    if (total === 0) {
      console.log(`[SyncAllModules] 📭 原站点无模块可同步，结束`);
      return;
    }
    // 初始化统计信息
    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;
    console.log(`[SyncAllPages] 🚦 开始批量同步，总计 ${total} 个页面`);
    // 串行同步每个页面
    for (let index = 0; index < total; index++) {
      const moduleTitle = oldModuleList[index];
      const current = index + 1;
      const remaining = total - current;
      const progress = ((current / total) * 100).toFixed(1);

      console.log(
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
    // 汇总结果
    console.log(`\n[SyncAllModules] 🎯 同步完成！`);
    console.log(`├─ 总计：${total} 个模块`);
    console.log(`├─ 成功：${successCount} 个（含跳过 ${skipCount} 个）`);
    console.log(`└─ 失败：${failCount} 个`);
  } catch (error) {
    console.error(`[SyncAllModules] 💥 批量同步流程异常终止:`, error);
    throw error; // 抛出错误让上层处理
  }
}
export { syncSingleModule, syncModules };
