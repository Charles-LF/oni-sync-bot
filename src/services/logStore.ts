import { Context } from "koishi";
import type { OniLogRow } from "../plugins/databaseExtension";
import { getErrorMessage, logger } from "../utils/tools";

/** 一条日志（与数据库行结构一致） */
export type OniLogEntry = OniLogRow;

export type OniLogLevel = "info" | "warn" | "error";

/** 查询条件（全部可选，空数组/空串表示不过滤） */
export interface OniLogFilter {
  levels?: OniLogLevel[];
  scopes?: string[];
  keyword?: string;
  /** 起始毫秒时间戳（含） */
  from?: number;
  /** 结束毫秒时间戳（含） */
  to?: number;
  limit?: number;
  offset?: number;
}

export interface OniLogScopeStat {
  name: string;
  count: number;
}

/** 查询结果 */
export interface OniLogSnapshot {
  /** 按时间正序 */
  entries: OniLogEntry[];
  /** 命中筛选条件的条数 */
  total: number;
  /** 缓冲区内的总条数（不受筛选影响） */
  totalAll: number;
  /** 全量统计，供前端生成筛选下拉 */
  scopes: OniLogScopeStat[];
  levels: Record<OniLogLevel, number>;
}

/** 推给前端的轻量摘要：只有它变化时才触发前端重新查询 */
export interface OniLogSummary {
  totalAll: number;
  lastId: number;
  version: number;
}

/** 最多保留的日志条数 */
export const MAX_LOG_RECORDS = 3000;

/** 落库节流间隔 */
const FLUSH_DELAY = 500;
/** 累计写满这么多条才做一次裁剪，避免每次都读 3000 个 id */
const TRIM_EVERY = 200;
/** 推送摘要的节流间隔 */
const NOTIFY_DELAY = 300;

/**
 * 日志模块归类。
 *
 * 业务日志都有 `[前缀]`，据此把「增量更新 / 全量同步 / 登录 / AI」等分开，
 * 前端不用解析文本。匹配不上的归入 `其他`。
 */
const SCOPE_RULES: Array<{ test: RegExp; scope: string }> = [
  { test: /日志读取失败|日志写入失败|记录日志失败|清空历史日志失败/, scope: "日志系统" },
  { test: /\[增量更新流程\]/, scope: "增量更新" },
  { test: /\[SyncAllPages\]|所有页面同步/, scope: "全量页面同步" },
  { test: /\[SyncAllModules\]|\[moduleSync\]|同步所有模块/, scope: "模块同步" },
  { test: /\[SyncAllImgs\]|\[imgSync\]|同步所有图片|转存图片/, scope: "图片同步" },
  { test: /贡献者同步|同步贡献者/, scope: "贡献者同步" },
  { test: /页面缓存/, scope: "页面缓存更新" },
  { test: /\[syncSinglePage\]|\[数据库初始化\]/, scope: "页面同步" },
  { test: /\[ai\]|Agent 决定检索|DeepSeek|资料中未提及/, scope: "AI 问答" },
  { test: /\[wikiBot\]|正文缓存/, scope: "Wiki 客户端" },
  { test: /\[todolist\]|TodoList|待办/, scope: "TodoList" },
  { test: /定时任务|定时同步|\[cron\]/, scope: "定时任务" },
  { test: /登录|relogin|assertuserfailed|Cookie/i, scope: "登录" },
];

/** 由日志内容推断业务模块 */
export function resolveScope(name: string, message: string): string {
  const text = message ?? "";
  for (const rule of SCOPE_RULES) {
    if (rule.test.test(text)) return rule.scope;
  }
  if (name === "oni-ai") return "AI 问答";
  if (name === "oni-todolist") return "TodoList";
  return "其他";
}

function normalizeLevel(type: string): OniLogLevel | undefined {
  if (type === "warn") return "warn";
  if (type === "error") return "error";
  if (type === "info") return "info";
  return undefined;
}

/**
 * 日志仓库：内存保存最近 3000 条供控制台查询，并节流写入 `onilogs` 表，
 * 重启后从库里恢复，因此前端能看到历史。
 */
export class LogStore {
  private entries: OniLogEntry[] = [];
  private pending: OniLogEntry[] = [];
  /** 仅用于前端 key 的去重计数，与数据库自增 id 无关 */
  private localId = 0;
  private version = 0;
  private writtenSinceTrim = 0;
  private flushTimer?: () => void;
  private notifyTimer?: () => void;
  private loaded = false;

  constructor(
    private readonly ctx: Context,
    private readonly onChange: (summary: OniLogSummary) => void,
  ) {}

  async load(retry = 1): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const rows = await this.ctx.database.get("onilogs", {}, [
        "id",
        "time",
        "level",
        "name",
        "scope",
        "message",
      ]);
      rows.sort((a, b) => a.id - b.id);
      // 恢复期间可能已经产生了新日志：重新编号后合并，避免前端 key 重复
      let offset = rows.length > 0 ? rows[rows.length - 1].id : 0;
      for (const entry of this.entries) entry.id = ++offset;
      this.entries = [...rows, ...this.entries].slice(-MAX_LOG_RECORDS);
      this.localId = offset;
      logger.debug(`[log] 已从数据库恢复 ${rows.length} 条日志`);
    } catch (error) {
      // 首次启动时数据表可能还没建好，等一轮再试
      if (retry > 0) {
        this.loaded = false;
        this.ctx.setTimeout(() => void this.load(retry - 1), 1000);
        return;
      }
      logger.warn(`日志读取失败：${getErrorMessage(error)}`);
    }
  }

  /** 追加一条日志（type 非 info/warn/error 时忽略） */
  append(input: { type: string; name: string; content?: unknown }): void {
    const level = normalizeLevel(input.type);
    if (!level) return;

    const message = String(input.content ?? "").trim();
    if (!message) return;

    const entry: OniLogEntry = {
      id: ++this.localId,
      time: Date.now(),
      level,
      name: input.name,
      scope: resolveScope(input.name, message),
      message,
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_RECORDS) {
      this.entries.splice(0, this.entries.length - MAX_LOG_RECORDS);
    }

    this.pending.push(entry);
    this.scheduleFlush();
    this.scheduleNotify();
  }

  summary(): OniLogSummary {
    return {
      totalAll: this.entries.length,
      lastId: this.entries[this.entries.length - 1]?.id ?? 0,
      version: this.version,
    };
  }

  /** 按条件查询（内存过滤，3000 条以内足够快） */
  query(filter: OniLogFilter = {}): OniLogSnapshot {
    const levels = new Set<string>(filter.levels ?? []);
    const scopes = new Set<string>(filter.scopes ?? []);
    const keyword = (filter.keyword ?? "").trim().toLowerCase();
    const from = filter.from ?? 0;
    const to = filter.to ?? Number.MAX_SAFE_INTEGER;

    const base = this.entries.filter((entry) => {
      if (entry.time < from || entry.time > to) return false;
      if (!keyword) return true;
      return (
        entry.message.toLowerCase().includes(keyword) ||
        entry.scope.toLowerCase().includes(keyword) ||
        entry.name.toLowerCase().includes(keyword)
      );
    });

    const matchLevel = (entry: OniLogEntry) =>
      levels.size === 0 || levels.has(entry.level);
    const matchScope = (entry: OniLogEntry) =>
      scopes.size === 0 || scopes.has(entry.scope);
    const matched = base.filter(
      (entry) => matchLevel(entry) && matchScope(entry),
    );

    const limit = Math.max(1, Math.min(filter.limit ?? 200, MAX_LOG_RECORDS));
    const offset = Math.max(0, filter.offset ?? 0);
    // 从最新的往旧取，前端拿到后自行决定展示顺序
    const end = Math.max(0, matched.length - offset);
    const start = Math.max(0, end - limit);

    return {
      entries: matched.slice(start, end),
      total: matched.length,
      totalAll: this.entries.length,
      // 分面统计：每个维度只受其它维度影响，选中模块后级别数字才会跟着变
      scopes: this.scopeStats(base.filter(matchLevel)),
      levels: this.levelStats(base.filter(matchScope)),
    };
  }

  /** 清空内存与数据库 */
  async clear(): Promise<number> {
    const removed = this.entries.length;
    this.entries = [];
    this.pending = [];
    this.writtenSinceTrim = 0;
    this.version++;
    if (this.flushTimer) {
      this.flushTimer();
      this.flushTimer = undefined;
    }
    try {
      await this.ctx.database.remove("onilogs", {});
    } catch (error) {
      logger.warn(`清空历史日志失败：${getErrorMessage(error)}`);
    }
    this.onChange(this.summary());
    return removed;
  }

  private scopeStats(source: OniLogEntry[] = this.entries): OniLogScopeStat[] {
    const counts = new Map<string, number>();
    for (const entry of source) {
      counts.set(entry.scope, (counts.get(entry.scope) ?? 0) + 1);
    }
    return [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  private levelStats(
    source: OniLogEntry[] = this.entries,
  ): Record<OniLogLevel, number> {
    const stats: Record<OniLogLevel, number> = { info: 0, warn: 0, error: 0 };
    for (const entry of source) stats[entry.level]++;
    return stats;
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = this.ctx.setTimeout(() => {
      this.notifyTimer = undefined;
      this.version++;
      this.onChange(this.summary());
    }, NOTIFY_DELAY);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = this.ctx.setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DELAY);
  }

  /** 批量落库（含裁剪） */
  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;

    const rows = this.pending;
    this.pending = [];
    try {
      // upsert 支持批量；不带 id 时按 autoInc 插入
      await this.ctx.database.upsert(
        "onilogs",
        rows.map(({ id: _id, ...rest }) => rest),
      );
      this.writtenSinceTrim += rows.length;
      if (this.writtenSinceTrim >= TRIM_EVERY) {
        this.writtenSinceTrim = 0;
        await this.trim();
      }
    } catch (error) {
      logger.warn(`日志写入失败（已丢弃 ${rows.length} 条）：${getErrorMessage(error)}`);
    }
    if (this.pending.length > 0) this.scheduleFlush();
  }

  /** 把库里超出上限的旧日志删掉 */
  private async trim(): Promise<void> {
    const rows = await this.ctx.database.get("onilogs", {}, ["id"]);
    const overflow = rows.length - MAX_LOG_RECORDS;
    if (overflow <= 0) return;

    rows.sort((a, b) => a.id - b.id);
    const ids = rows.slice(0, overflow).map((row) => row.id);
    await this.ctx.database.remove("onilogs", { id: { $in: ids } });
  }
}
