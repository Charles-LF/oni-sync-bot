/**
 * 忽略规则（领域层值对象）：纯函数 + 纯数据，不依赖 Koishi / 数据库 / mwn。
 *
 * 规则有两类来源：
 * 1. 数据库 `sync_ignore` 表（运维可增删）；
 * 2. 执行器里保留的内置名单（向后兼容，老配置里没有这些名字）。
 *
 * `name` 支持 `*` 通配（如 `File:Icon_*`）。比较前统一归一化：
 * 去首尾空白、下划线视作空格、折叠连续空白、忽略大小写；
 * 图片与模块再去掉命名空间前缀，这样 `File:A.png` 与 `A.png` 视为同一条规则。
 */

export const IGNORE_TYPES = ["page", "image", "module"] as const;

export type IgnoreType = (typeof IGNORE_TYPES)[number];

export interface IgnoreRule {
  type: IgnoreType;
  /** 面向人的原始写法，展示用（不做归一化） */
  name: string;
  /** 忽略原因，展示在任务详情里 */
  reason?: string;
}

/** 落库后的规则（领域实体） */
export interface StoredIgnoreRule extends IgnoreRule {
  id: number;
  reason: string;
  createdAt: number;
}

export function isIgnoreType(value: unknown): value is IgnoreType {
  return (
    typeof value === "string" &&
    (IGNORE_TYPES as readonly string[]).includes(value)
  );
}

const IMAGE_PREFIXES = ["file:", "image:", "文件:"];
const MODULE_PREFIX = "module:";

/** 归一化：规则与被检查对象都走这一套，保证「写法不同、含义相同」能命中 */
export function normalizeIgnoreName(type: IgnoreType, name: string): string {
  let value = (name ?? "")
    .trim()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!value) return "";

  if (type === "image") {
    for (const prefix of IMAGE_PREFIXES) {
      if (value.startsWith(prefix)) {
        value = value.slice(prefix.length).trim();
        break;
      }
    }
  } else if (type === "module" && value.startsWith(MODULE_PREFIX)) {
    value = value.slice(MODULE_PREFIX.length).trim();
  }
  return value;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledRule {
  rule: IgnoreRule;
  normalized: string;
  /** 含 `*` 时才编译，纯精确匹配不必付出正则开销 */
  pattern?: RegExp;
}

/**
 * 一组忽略规则的匹配器。
 *
 * 每次同步开始时由应用层从仓储加载一次，循环里只做内存匹配，
 * 不会因为条数变多而多打数据库。
 */
export class IgnoreRuleSet {
  private readonly compiled: CompiledRule[];

  constructor(rules: readonly IgnoreRule[] = []) {
    this.compiled = rules
      .filter((rule) => isIgnoreType(rule?.type) && Boolean(rule?.name?.trim()))
      .map((rule) => {
        const normalized = normalizeIgnoreName(rule.type, rule.name);
        return {
          rule,
          normalized,
          pattern: normalized.includes("*")
            ? new RegExp(
                `^${normalized
                  .split("*")
                  .map(escapeRegExp)
                  .join(".*")}$`,
              )
            : undefined,
        };
      });
  }

  static readonly EMPTY = new IgnoreRuleSet();

  get size(): number {
    return this.compiled.length;
  }

  /** 命中则返回原始规则（保留原始写法与原因），否则 undefined */
  match(type: IgnoreType, name: string): IgnoreRule | undefined {
    const target = normalizeIgnoreName(type, name);
    if (!target) return undefined;

    for (const item of this.compiled) {
      if (item.rule.type !== type) continue;
      if (item.pattern) {
        if (item.pattern.test(target)) return item.rule;
      } else if (item.normalized === target) {
        return item.rule;
      }
    }
    return undefined;
  }

  ofType(type: IgnoreType): IgnoreRule[] {
    return this.compiled
      .filter((item) => item.rule.type === type)
      .map((item) => item.rule);
  }
}
