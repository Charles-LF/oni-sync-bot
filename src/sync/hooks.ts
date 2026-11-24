import type { SyncReporter } from "../domain/sync/ports";

/**
 * 全量同步循环（页面 / 图片 / 模块）共用的钩子。
 *
 * 加这一层的目的是让「批量遍历」可暂停、可停止，而**不动**每一次的
 * `syncOne()`——原子同步逻辑保持原样，只是循环在条目之间留了一个检查点。
 *
 * 同时兼作观测端口：`log` / `item` 由应用层注入（任务详情弹窗的数据来源），
 * 执行器不需要知道自己是在写数据库还是推网页。
 */
export interface SyncLoopHooks extends SyncReporter {
  /** 每个条目开始前调用；抛错即可中断（控制台的暂停 / 停止靠它） */
  checkpoint?: () => Promise<void>;
  /** 仅上报，不参与控制流 */
  onProgress?: (info: SyncLoopProgress) => void;
}

export interface SyncLoopProgress {
  phase: string;
  current: number;
  total: number;
  title?: string;
  synced: number;
  skipped: number;
  failed: number;
}

export interface SyncLoopResult {
  total: number;
  synced: number;
  skipped: number;
  failed: number;
}

/** 主动停止时抛出的错误名，循环内部据此区分「中止」与「真异常」 */
export { ABORT_ERROR_NAME } from "../domain/sync/runToken";
