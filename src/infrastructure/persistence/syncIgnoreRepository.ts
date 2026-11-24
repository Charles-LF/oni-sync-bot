import { Context } from "koishi";
import {
  IgnoreRuleSet,
  normalizeIgnoreName,
  type IgnoreRule,
  type IgnoreType,
  type StoredIgnoreRule,
} from "../../domain/sync/ignoreRule";
import {
  DEFAULT_IGNORE_RULES,
  IGNORE_SEED_VERSION,
} from "../../domain/sync/defaultIgnores";
import { SYNC_CONFIG_KEYS } from "./syncRepository";
import { getErrorMessage, logger } from "../../utils/tools";

/**
 * `sync_ignore` 的仓储实现（基础设施层）。
 *
 * 领域/应用层只看到 `IgnoreRule[]`、`StoredIgnoreRule[]` 这样的纯数据，
 * 表名、归一化列、主键形式都封在这一层。
 */
export class SyncIgnoreRepository {
  constructor(private readonly ctx: Context) {}

  async list(type?: IgnoreType): Promise<StoredIgnoreRule[]> {
    const rows = await this.ctx.database.get(
      "sync_ignore",
      type ? { type } : {},
      { sort: { createdAt: "desc" } },
    );
    return rows.map(toStoredRule);
  }

  /** 查重：按「类型 + 归一化名称」找，`File:A.png` 与 `A.png` 视为同一条 */
  async find(
    type: IgnoreType,
    name: string,
  ): Promise<StoredIgnoreRule | undefined> {
    const normalized = normalizeIgnoreName(type, name);
    if (!normalized) return undefined;
    const rows = await this.ctx.database.get("sync_ignore", { type, normalized });
    return rows[0] ? toStoredRule(rows[0]) : undefined;
  }

  async insert(rule: IgnoreRule): Promise<StoredIgnoreRule> {
    const name = rule.name.trim();
    const normalized = normalizeIgnoreName(rule.type, name);
    const createdAt = Date.now();
    const created = await this.ctx.database.create("sync_ignore", {
      type: rule.type,
      name,
      normalized,
      reason: (rule.reason ?? "").trim(),
      createdAt,
    });

    if (created?.id) return toStoredRule(created);

    // 个别驱动不回传自增主键，退回按归一化名再查一次
    const stored = await this.find(rule.type, name);
    if (!stored) throw new Error(`忽略规则写入后读取失败：${rule.type}/${name}`);
    return stored;
  }

  async delete(type: IgnoreType, name: string): Promise<number> {
    const normalized = normalizeIgnoreName(type, name);
    if (!normalized) return 0;
    const result = await this.ctx.database.remove("sync_ignore", {
      type,
      normalized,
    });
    return result?.removed ?? 0;
  }

  /**
   * 补种内置默认规则（见 `domain/sync/defaultIgnores.ts`）。
   *
   * 只在 `IGNORE_SEED_VERSION` 变化时执行一次：同版本重启直接返回 0，
   * 管理员用 `sync.ignore.remove` 删掉的规则不会复活；库里已经存在的同名规则也跳过。
   * 返回本次真正插入的条数。
   */
  async seedDefaults(
    version: string = IGNORE_SEED_VERSION,
    rules: readonly IgnoreRule[] = DEFAULT_IGNORE_RULES,
  ): Promise<number> {
    const rows = await this.ctx.database.get("sync_config", {
      key: SYNC_CONFIG_KEYS.ignoreSeedVersion,
    });
    if (rows[0]?.value === version) return 0;

    let inserted = 0;
    for (const rule of rules) {
      if (await this.find(rule.type, rule.name)) continue;
      await this.insert(rule);
      inserted += 1;
    }

    await this.ctx.database.upsert("sync_config", [
      { key: SYNC_CONFIG_KEYS.ignoreSeedVersion, value: version },
    ]);
    return inserted;
  }

  /** 同步开始前加载一次（读失败不影响同步：退化为「没有动态规则」） */
  async loadRuleSet(): Promise<IgnoreRuleSet> {
    try {
      return new IgnoreRuleSet(await this.list());
    } catch (error) {
      logger.warn(
        `读取忽略规则失败，本轮不应用动态规则：${getErrorMessage(error)}`,
      );
      return new IgnoreRuleSet();
    }
  }
}

function toStoredRule(row: {
  id: number;
  type: string;
  name: string;
  reason?: string;
  createdAt: number;
}): StoredIgnoreRule {
  return {
    id: row.id,
    type: row.type as IgnoreType,
    name: row.name,
    reason: row.reason ?? "",
    createdAt: row.createdAt,
  };
}
