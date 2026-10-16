import { Mwn } from "mwn";
import {
  getAndProcessPageContent,
  logger,
  getErrorMessage,
} from "../utils/tools";
import { sleep } from "../utils/async";

export interface SyncResult {
  success: boolean;
  reason?: string;
}

/** 模块同步的可调参数 */
export interface ModuleSyncOptions {
  /** 模块命名空间 ID */
  moduleNamespace: number;
  /** 忽略的模块标题 */
  ignoredModules: string[];
  /** 同步成功后等待毫秒数 */
  intervalSuccess: number;
  /** 同步失败后等待毫秒数 */
  intervalFailed: number;
}

const DEFAULT_OPTIONS: ModuleSyncOptions = {
  moduleNamespace: 828,
  ignoredModules: [],
  intervalSuccess: 500,
  intervalFailed: 1000,
};

const DEFAULT_USER = "同步坤器人";

/** 与 PageSyncer / ImageSyncer 保持一致的构造签名 */
export interface ModuleSyncerDependencies {
  options?: Partial<ModuleSyncOptions>;
}

/**
 * 把 wiki.gg 的 Module 命名空间页面同步到 bwiki。
 * 依赖全部由构造函数注入，可安全地实例化多份。
 */
export class ModuleSyncer {
  private readonly options: ModuleSyncOptions;

  constructor(
    private readonly source: Mwn,
    private readonly target: Mwn,
    deps: ModuleSyncerDependencies = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
  }

  async syncOne(moduleTitle: string, user?: string): Promise<SyncResult> {
    if (this.options.ignoredModules.includes(moduleTitle)) {
      logger.info(`[SyncModule] 🚫 模块 ${moduleTitle} 在忽略列表中，跳过`);
      return { success: true, reason: "ignored" };
    }

    try {
      logger.info(`[SyncModule] 🔍 开始获取模块 ${moduleTitle} 的内容`);

      // Dev: 命名空间需要映射到 Module:Dev/ 下
      let targetTitle = moduleTitle;
      if (/^Dev:/i.test(moduleTitle)) {
        const subPageName = moduleTitle.replace(/^Dev:/i, "");
        targetTitle = `Module:Dev/${subPageName}`;
        logger.info(
          `[SyncModule] 🔀 检测到 Dev 命名空间，路径映射: ${moduleTitle} -> ${targetTitle}`,
        );
      }

      const [oldContent, newContent] = await Promise.all([
        getAndProcessPageContent(this.source, moduleTitle),
        getAndProcessPageContent(this.target, targetTitle),
      ]);

      if (oldContent === newContent) {
        logger.info(`[SyncModule] 🟡 模块 ${moduleTitle} 内容未改变，跳过`);
        return { success: true, reason: "no_change" };
      }

      await this.target.save(
        targetTitle,
        oldContent,
        `由：${user || "同步坤器人手动"} 触发更改，此时同步`,
      );

      logger.info(`[SyncModule] ✅ 模块 ${moduleTitle} 同步成功`);
      return { success: true, reason: "synced" };
    } catch (error) {
      const errMsg = getErrorMessage(error);
      logger.error(`[SyncModule] ❌ 模块 ${moduleTitle} 同步失败:`, errMsg);
      return { success: false, reason: errMsg };
    }
  }

  async listAll(): Promise<string[]> {
    logger.info(
      `[SyncAllModules] 📥 开始获取原站点所有模块（命名空间${this.options.moduleNamespace}）`,
    );

    const allModules: string[] = [];
    const queryGen = this.source.continuedQueryGen({
      action: "query",
      list: "allpages",
      apnamespace: this.options.moduleNamespace,
      aplimit: "max",
      apdir: "ascending",
    });

    for await (const res of queryGen) {
      const titles =
        res.query?.allpages?.map((page: { title: string }) => page.title) || [];
      allModules.push(...titles);
      logger.info(`[SyncAllModules] 📄 已获取 ${allModules.length} 个模块`);
    }

    logger.info(
      `[SyncAllModules] 📊 原站点总计获取到 ${allModules.length} 个模块`,
    );
    return allModules;
  }

  /** 批量同步所有模块：先串行同步一轮，再重试失败的 */
  async syncAll(): Promise<void> {
    try {
      const oldModuleList = await this.listAll();
      const total = oldModuleList.length;
      if (total === 0) {
        logger.info(`[SyncAllModules] 📭 原站点无模块可同步，结束`);
        return;
      }

      let successCount = 0;
      let failCount = 0;
      let skipCount = 0;
      const failedModules: string[] = [];

      logger.info(`[SyncAllModules] 🚦 开始批量同步，总计 ${total} 个模块`);

      // 第一轮：串行同步
      for (let index = 0; index < total; index++) {
        const moduleTitle = oldModuleList[index];
        const current = index + 1;
        const remaining = total - current;
        const progress = ((current / total) * 100).toFixed(1);

        logger.info(
          `\n[SyncAllModules] 📈 进度 [${current}/${total}] (${progress}%) - 处理 ${moduleTitle} | 剩余 ${remaining} 个`,
        );

        const result = await this.syncOne(moduleTitle, DEFAULT_USER);
        if (!result.success) {
          failCount++;
          failedModules.push(moduleTitle);
          await sleep(this.options.intervalFailed);
        } else {
          successCount++;
          if (result.reason === "ignored" || result.reason === "no_change") {
            skipCount++;
          }
          await sleep(this.options.intervalSuccess);
        }
      }

      // 第二轮：重试失败项
      if (failedModules.length > 0) {
        logger.info(
          `\n[SyncAllModules] 🔄 ===== 开始重试 ${failedModules.length} 个失败模块 =====`,
        );

        const stillFailed: string[] = [];

        for (const moduleTitle of failedModules) {
          logger.info(`\n[SyncAllModules] 🔁 重试中: ${moduleTitle}`);

          const result = await this.syncOne(moduleTitle, DEFAULT_USER);
          if (result.success) {
            successCount++;
            failCount--; // 修正统计数据
            if (result.reason === "ignored" || result.reason === "no_change") {
              skipCount++;
            }
            logger.info(`[SyncAllModules] ✅ 模块 ${moduleTitle} 重试成功`);
            await sleep(this.options.intervalSuccess);
          } else {
            stillFailed.push(moduleTitle);
            logger.info(`[SyncAllModules] ❌ 模块 ${moduleTitle} 再次失败`);
            await sleep(this.options.intervalFailed);
          }
        }

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

      logger.info(`\n[SyncAllModules] 🎯 同步完成！`);
      logger.info(`├─ 总计：${total} 个模块`);
      logger.info(`├─ 成功：${successCount} 个（含跳过 ${skipCount} 个）`);
      logger.info(`└─ 失败：${failCount} 个`);
    } catch (error) {
      logger.error(
        `[SyncAllModules] 💥 批量同步流程异常终止:`,
        getErrorMessage(error),
      );
      throw error; // 抛出错误让上层处理
    }
  }
}
