import type { Mwn } from "mwn";
import type { IgnoreRuleSet } from "../../domain/sync/ignoreRule";
import type { SyncLoopHooks, SyncLoopResult } from "../../sync/hooks";
import { ImageSyncer } from "../../sync/imgSync";
import { ModuleSyncer } from "../../sync/moduleSync";
import { PageSyncer, type Database } from "../../sync/pageSync";

/**
 * 全量同步用例（应用层）。
 *
 * 把「页面 / 图片 / 模块」三种全量任务的编排（选哪个执行器、汇报文案）从
 * 控制台插件里抽出来；插件只负责准备依赖、接上运行记录器、启动任务。
 */

/** 与任务卡片的 id 一致；增量同步不在此列 */
export type FullSyncTarget = "pages" | "images" | "modules";

export interface FullSyncDeps {
  source: Mwn;
  target: Mwn;
  /** 页面同步需要维护 wikipages 索引 */
  database?: Database;
  /** 数据库驱动的忽略规则（任务开始前加载一次） */
  ignoreRules?: IgnoreRuleSet;
}

export interface FullSyncResult extends SyncLoopResult {
  message: string;
}

/** 量词与动作词只在这里维护，避免汇报文案散落各处 */
const TARGETS: Record<FullSyncTarget, { label: string; unit: string; verb: string }> = {
  pages: { label: "页面", unit: "个", verb: "同步" },
  images: { label: "图片", unit: "张", verb: "转存" },
  modules: { label: "模块", unit: "个", verb: "同步" },
};

export class FullSyncUseCase {
  constructor(private readonly deps: FullSyncDeps) {}

  async execute(
    target: FullSyncTarget,
    hooks: SyncLoopHooks = {},
  ): Promise<FullSyncResult> {
    const stats = await this.run(target, hooks);
    return { ...stats, message: describeFullSync(target, stats) };
  }

  private run(
    target: FullSyncTarget,
    hooks: SyncLoopHooks,
  ): Promise<SyncLoopResult> {
    switch (target) {
      case "pages":
        return new PageSyncer(this.deps.source, this.deps.target, {
          database: this.deps.database,
          ignoreRules: this.deps.ignoreRules,
        }).syncAll(hooks);
      case "images":
        return new ImageSyncer(this.deps.source, this.deps.target, {
          ignoreRules: this.deps.ignoreRules,
        }).syncAll(hooks);
      case "modules":
        return new ModuleSyncer(this.deps.source, this.deps.target, {
          ignoreRules: this.deps.ignoreRules,
        }).syncAll(hooks);
    }
  }
}

/** 结束摘要：控制台、群通知与 `sync_config.last_result:*` 共用同一份文案 */
export function describeFullSync(
  target: FullSyncTarget,
  stats: SyncLoopResult,
): string {
  const { label, unit, verb } = TARGETS[target];
  return `${label} ${stats.total} ${unit}：${verb} ${stats.synced}、跳过 ${stats.skipped}、失败 ${stats.failed}`;
}
