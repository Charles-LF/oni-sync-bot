import {
  classifySyncResult,
  type SyncAction,
  type SyncItemOutcome,
  type SyncResultLike,
} from "./decision";

/**
 * 应用层与「任务详情」之间的输出端口（六边形架构的出站端口）。
 *
 * 应用层只往这里写，不关心是落库、广播到网页，还是直接丢弃；
 * 具体实现见 `infrastructure/console/syncRunRecorder.ts`。
 */

export type SyncLogLevel = "info" | "warn" | "error";

export interface SyncItemEvent {
  /** 页面标题 / 图片名 / 模块名 */
  title: string;
  action: SyncAction;
  reason: string;
  /** 给人看的一句话 */
  message: string;
  at: number;
}

export interface SyncReporter {
  /** 一行日志（网页端实时滚动） */
  log?(level: SyncLogLevel, message: string): void;
  /** 条目级结果（成功 / 跳过 / 失败列表） */
  item?(item: SyncItemEvent): void;
}

/** 不收集任何东西的实现：命令、单测或不需要观测的调用可以直接用它 */
export const NULL_REPORTER: SyncReporter = {};

const ACTION_ICONS: Record<SyncAction, string> = {
  synced: "✅",
  skipped: "⏭️",
  failed: "❌",
};

/**
 * 记一条条目级结果：结构化条目 + 一行可读日志。
 *
 * 执行器只管返回 `{ success, reason }`，语义解释统一在这里完成，
 * 避免每个 syncAll 循环各写一套 `if (reason === 'ignored')`。
 */
export function reportSyncItem(
  reporter: SyncReporter | undefined,
  title: string,
  result: SyncResultLike,
  tag?: string,
): SyncItemOutcome {
  const outcome = classifySyncResult(result);
  reporter?.item?.({ title, ...outcome, at: Date.now() });

  const prefix = tag ? `${tag} ` : "";
  reporter?.log?.(
    outcome.action === "failed" ? "error" : "info",
    `${prefix}${ACTION_ICONS[outcome.action]} ${title}：${outcome.message}`,
  );
  return outcome;
}
