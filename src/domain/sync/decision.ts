import { IgnoreRuleSet, type IgnoreRule, type IgnoreType } from "./ignoreRule";

/**
 * 同步决策（领域层）：把「这次到底同步了 / 跳过了 / 失败了」的判定
 * 从执行器里抽出来，执行器只负责搬运数据，不再自己解释结果含义。
 */

export type SyncAction = "synced" | "skipped" | "failed";

/** Page / Image / ModuleSyncer 的返回值结构 */
export interface SyncResultLike {
  success: boolean;
  /** `synced` | `ignored` | `no_change` | `source_missing` | 具体错误信息 */
  reason?: string;
  /** 给人看的补充说明（命中哪条规则、内容差异等） */
  detail?: string;
}

export interface SyncItemOutcome {
  action: SyncAction;
  reason: string;
  message: string;
}

const REASON_LABELS: Record<string, string> = {
  synced: "同步成功",
  ignored: "命中忽略规则",
  no_change: "内容未变化",
  source_missing: "源站不存在",
  skipped: "已跳过",
};

/** 执行器结果 → 统一的三态语义 */
export function classifySyncResult(result: SyncResultLike): SyncItemOutcome {
  const reason = (result.reason ?? "").trim();

  if (!result.success) {
    return {
      action: "failed",
      reason: reason || "unknown",
      message: result.detail?.trim() || reason || "同步失败",
    };
  }

  const detail = result.detail?.trim();
  if (reason === "synced") {
    return { action: "synced", reason, message: detail || REASON_LABELS.synced };
  }

  return {
    action: "skipped",
    reason: reason || "skipped",
    message: detail || REASON_LABELS[reason] || reason || REASON_LABELS.skipped,
  };
}

export interface IgnoreDecision {
  ignored: boolean;
  /** 展示用的一句话；未忽略时为空串 */
  message: string;
  rule?: IgnoreRule;
}

/**
 * 是否跳过某个条目：先查数据库驱动的规则，再兜底代码里的静态名单。
 *
 * @param staticMatch 内置名单（`ignoredPages` / `ignoredImages` / `ignoredModules`）
 *   是否命中。保留它只是为了向后兼容，新规则请写进 `sync_ignore` 表。
 */
export function decideIgnore(
  rules: IgnoreRuleSet | undefined,
  type: IgnoreType,
  name: string,
  staticMatch = false,
): IgnoreDecision {
  const rule = rules?.match(type, name);
  if (rule) {
    const reason = rule.reason?.trim();
    return {
      ignored: true,
      rule,
      message: `命中忽略规则「${rule.name}」${reason ? `（${reason}）` : ""}`,
    };
  }
  if (staticMatch) return { ignored: true, message: "命中内置忽略名单" };
  return { ignored: false, message: "" };
}
