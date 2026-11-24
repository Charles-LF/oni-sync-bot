import { Mwn } from "mwn";
import {
  getAndProcessPageContent,
  logger,
  getErrorMessage,
} from "../utils/tools";
import { sleep } from "../utils/async";
import { decideIgnore } from "../domain/sync/decision";
import type { IgnoreRuleSet } from "../domain/sync/ignoreRule";
import { reportSyncItem } from "../domain/sync/ports";
import type { SyncLoopHooks, SyncLoopResult } from "./hooks";
import { ABORT_ERROR_NAME } from "./hooks";

export interface SyncResult {
  success: boolean;
  reason?: string;
  /** 给人看的补充说明（命中哪条忽略规则、错误详情） */
  detail?: string;
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
  /** 数据库驱动的忽略规则（应用层在同步开始前加载一次） */
  ignoreRules?: IgnoreRuleSet;
}

/**
 * 把 wiki.gg 的 Module 命名空间页面同步到 bwiki。
 * 依赖全部由构造函数注入，可安全地实例化多份。
 *
 * **只负责执行**：跳过判定在领域层 `decideIgnore`，调度在应用层用例。
 */
export class ModuleSyncer {
  private readonly options: ModuleSyncOptions;
  private readonly ignoreRules?: IgnoreRuleSet;

  constructor(
    private readonly source: Mwn,
    private readonly target: Mwn,
    deps: ModuleSyncerDependencies = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
    this.ignoreRules = deps.ignoreRules;
  }

  async syncOne(moduleTitle: string, user?: string): Promise<SyncResult> {
    const ignore = decideIgnore(
      this.ignoreRules,
      "module",
      moduleTitle,
      this.options.ignoredModules.includes(moduleTitle),
    );
    if (ignore.ignored) {
      logger.debug(`[SyncModule] 🚫 模块 ${moduleTitle} 跳过：${ignore.message}`);
      return { success: true, reason: "ignored", detail: ignore.message };
    }

    try {
      logger.debug(`[SyncModule] 🔍 开始获取模块 ${moduleTitle} 的内容`);

      // Dev: 命名空间需要映射到 Module:Dev/ 下
      let targetTitle = moduleTitle;
      if (/^Dev:/i.test(moduleTitle)) {
        const subPageName = moduleTitle.replace(/^Dev:/i, "");
        targetTitle = `Module:Dev/${subPageName}`;
        logger.debug(
          `[SyncModule] 🔀 检测到 Dev 命名空间，路径映射: ${moduleTitle} -> ${targetTitle}`,
        );
      }

      const [oldContent, newContent] = await Promise.all([
        getAndProcessPageContent(this.source, moduleTitle),
        getAndProcessPageContent(this.target, targetTitle),
      ]);

      if (oldContent === newContent) {
        logger.debug(`[SyncModule] 🟡 模块 ${moduleTitle} 内容未改变，跳过`);
        return { success: true, reason: "no_change" };
      }

      await this.target.save(
        targetTitle,
        oldContent,
        `由：${user || "同步坤器人手动"} 触发更改，此时同步`,
      );

      logger.debug(`[SyncModule] ✅ 模块 ${moduleTitle} 同步成功`);
      return { success: true, reason: "synced" };
    } catch (error) {
      const errMsg = getErrorMessage(error);
      logger.debug(`[SyncModule] ❌ 模块 ${moduleTitle} 同步失败: ${errMsg}`);
      return { success: false, reason: errMsg };
    }
  }

  async listAll(hooks: SyncLoopHooks = {}): Promise<string[]> {
    hooks.log?.(
      "info",
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
      logger.debug(`[SyncAllModules] 📄 已获取 ${allModules.length} 个模块`);
    }

    hooks.log?.(
      "info",
      `[SyncAllModules] 📊 原站点总计获取到 ${allModules.length} 个模块`,
    );
    return allModules;
  }

  /** 批量同步所有模块：先串行同步一轮，再重试失败的 */
  async syncAll(hooks: SyncLoopHooks = {}): Promise<SyncLoopResult> {
    const emit = (info: Partial<Parameters<NonNullable<SyncLoopHooks["onProgress"]>>[0]>) =>
      hooks.onProgress?.({
        phase: "同步模块",
        current: 0,
        total: 0,
        synced: 0,
        skipped: 0,
        failed: 0,
        ...info,
      });

    try {
      emit({ phase: "列举模块" });
      const oldModuleList = await this.listAll(hooks);
      const total = oldModuleList.length;
      if (total === 0) {
        hooks.log?.("info", `[SyncAllModules] 📭 原站点无模块可同步，结束`);
        return { total: 0, synced: 0, skipped: 0, failed: 0 };
      }

      let successCount = 0;
      let failCount = 0;
      let skipCount = 0;
      const failedModules: string[] = [];

      hooks.log?.(
        "info",
        `[SyncAllModules] 🚦 开始批量同步，总计 ${total} 个模块`,
      );

      // 第一轮：串行同步
      for (let index = 0; index < total; index++) {
        await hooks.checkpoint?.();
        const moduleTitle = oldModuleList[index];
        const current = index + 1;

        const outcome = reportSyncItem(
          hooks,
          moduleTitle,
          await this.syncOne(moduleTitle, DEFAULT_USER),
        );

        if (outcome.action === "failed") {
          failCount++;
          failedModules.push(moduleTitle);
          await sleep(this.options.intervalFailed);
        } else {
          successCount++;
          if (outcome.action === "skipped") skipCount++;
          await sleep(this.options.intervalSuccess);
        }

        emit({
          current,
          total,
          title: moduleTitle,
          synced: successCount - skipCount,
          skipped: skipCount,
          failed: failCount,
        });
      }

      // 第二轮：重试失败项
      const stillFailed: string[] = [];
      if (failedModules.length > 0) {
        hooks.log?.(
          "warn",
          `[SyncAllModules] 🔄 开始重试 ${failedModules.length} 个失败模块`,
        );

        for (const moduleTitle of failedModules) {
          await hooks.checkpoint?.();
          const outcome = reportSyncItem(
            hooks,
            moduleTitle,
            await this.syncOne(moduleTitle, DEFAULT_USER),
            "🔁 重试",
          );

          if (outcome.action === "failed") {
            stillFailed.push(moduleTitle);
            await sleep(this.options.intervalFailed);
            continue;
          }

          successCount++;
          failCount--;
          if (outcome.action === "skipped") skipCount++;
          await sleep(this.options.intervalSuccess);
        }
      }

      hooks.log?.(
        "info",
        `[SyncAllModules] 🎯 同步结束：总计 ${total} 个模块，成功 ${successCount}（含跳过 ${skipCount}），失败 ${stillFailed.length}`,
      );
      if (stillFailed.length > 0) {
        hooks.log?.(
          "warn",
          `❌ 重试后仍失败：${stillFailed.slice(0, 20).join("、")}` +
            (stillFailed.length > 20 ? ` 等 ${stillFailed.length} 个` : ""),
        );
      }

      return {
        total,
        synced: successCount - skipCount,
        skipped: skipCount,
        failed: stillFailed.length,
      };
    } catch (error) {
      if (error instanceof Error && error.name === ABORT_ERROR_NAME) {
        throw error;
      }
      logger.error(
        `[SyncAllModules] 💥 批量同步流程异常终止:`,
        getErrorMessage(error),
      );
      throw error; // 抛出错误让上层处理
    }
  }
}
