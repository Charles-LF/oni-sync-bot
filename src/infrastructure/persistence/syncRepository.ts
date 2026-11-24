import { Context } from "koishi";
import type { SyncConfigRow, SyncLogRow } from "./databaseExtension";
import type {
  SyncChangeRecord,
  SyncImageFingerprint,
  SyncStatePort,
} from "../../application/sync/syncStatePort";
import { getErrorMessage, logger } from "../../utils/tools";

/** `sync_config` 里用到的键集中在此，避免各处散落字符串 */
export const SYNC_CONFIG_KEYS = {
  /** 上次成功同步的 ISO 时间串 */
  lastSyncTime: "last_sync_time",
  /** 各任务上次结果的键前缀（后面接任务 id） */
  lastResultPrefix: "last_result:",
} as const;

/** 一次批量的插入上限：SQLite 单语句变量数有上限，200 稳妥 */
const WRITE_CHUNK = 200;
/** 写满这么多条才做一次裁剪，避免每次都全表读 id */
const TRIM_EVERY = 200;

export type { SyncChangeRecord } from "../../application/sync/syncStatePort";

export interface SyncChangeListItem {
  id: string;
  title: string;
  user: string;
  timestamp: string;
  comment: string;
  sizeDiff: number;
}

export interface SyncLogQuery {
  offset?: number;
  limit?: number;
  keyword?: string;
}

export interface SyncLogPage {
  entries: SyncChangeListItem[];
  total: number;
  totalAll: number;
}

const LIST_FIELDS = ["id", "title", "user", "timestamp", "comment", "sizeDiff"] as const;

/**
 * 同步相关的持久化：水位、最近更改、图片指纹。
 *
 * 水位与 cron 放数据库而不是内存，Koishi 重启（部署 / 崩溃重拉）后增量不会重头再来。
 */
export class SyncRepository implements SyncStatePort {
  private configCache = new Map<string, string>();
  private imageCount?: number;
  private writtenSinceTrim = 0;

  constructor(private readonly ctx: Context) {}

  // ------------------------------------------------------------ 配置 / 水位

  async loadConfig(): Promise<void> {
    try {
      const rows = await this.ctx.database.get("sync_config", {});
      this.configCache = new Map(rows.map((row: SyncConfigRow) => [row.key, row.value]));
    } catch (error) {
      logger.warn(`读取同步配置失败：${getErrorMessage(error)}`);
    }
  }

  getConfig(key: string, fallback = ""): string {
    return this.configCache.get(key) ?? fallback;
  }

  async setConfig(key: string, value: string): Promise<void> {
    this.configCache.set(key, value);
    await this.ctx.database.upsert("sync_config", [{ key, value }]);
  }

  /** 上次成功同步的时间（毫秒）；从未同步过返回 undefined */
  getLastSyncTime(): number | undefined {
    const raw = this.configCache.get(SYNC_CONFIG_KEYS.lastSyncTime);
    if (!raw) return undefined;
    const time = Date.parse(raw);
    return Number.isFinite(time) ? time : undefined;
  }

  async setLastSyncTime(time: number | string): Promise<void> {
    const iso = typeof time === "string" ? time : new Date(time).toISOString();
    await this.setConfig(SYNC_CONFIG_KEYS.lastSyncTime, iso);
  }

  // ---------------------------------------------------------------- 最近更改

  /**
   * 批量写入变更记录，按 `id`（rcid）去重。
   * 返回真正新插入的条数。
   */
  async saveChanges(records: SyncChangeRecord[]): Promise<number> {
    if (records.length === 0) return 0;

    const unique = new Map<string, SyncChangeRecord>();
    for (const record of records) {
      if (!record.id || unique.has(record.id)) continue;
      unique.set(record.id, record);
    }

    let inserted = 0;
    const ids = [...unique.keys()];
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      const chunk = ids.slice(i, i + WRITE_CHUNK);
      const existing = await this.ctx.database.get("sync_logs", {
        id: { $in: chunk },
      }, ["id"]);
      const seen = new Set(existing.map((row) => row.id));
      const fresh = chunk
        .filter((id) => !seen.has(id))
        .map((id) => {
          const record = unique.get(id)!;
          return {
            id,
            title: record.title,
            user: record.user || "未知",
            timestamp: record.timestamp,
            comment: record.comment || "",
            sizeDiff: record.sizeDiff || 0,
            diffHtml: "",
            revid: record.revid || "",
            parentid: record.parentid || "",
            ns: record.ns ?? 0,
          };
        });

      if (fresh.length === 0) continue;
      await this.ctx.database.upsert("sync_logs", fresh);
      inserted += fresh.length;
    }

    this.writtenSinceTrim += inserted;
    return inserted;
  }

  /** 最近更改列表（按时间倒序，支持分页与关键词） */
  async listChanges(query: SyncLogQuery = {}): Promise<SyncLogPage> {
    const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
    const offset = Math.max(0, query.offset ?? 0);
    const keyword = (query.keyword ?? "").trim().toLowerCase();

    const totalAll = (await this.ctx.database.get("sync_logs", {}, ["id"])).length;

    if (keyword) {
      // 关键词走内存过滤：条数上限是 5000，一次全取比依赖驱动特有语法更稳
      const rows = await this.ctx.database.get("sync_logs", {}, [...LIST_FIELDS]);
      const matched = rows
        .filter(
          (row) =>
            row.title.toLowerCase().includes(keyword) ||
            row.user.toLowerCase().includes(keyword) ||
            row.comment.toLowerCase().includes(keyword),
        )
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return {
        entries: matched.slice(offset, offset + limit),
        total: matched.length,
        totalAll,
      };
    }

    const entries = await this.ctx.database.get("sync_logs", {}, {
      fields: [...LIST_FIELDS],
      sort: { timestamp: "desc" },
      limit,
      offset,
    });
    return { entries, total: totalAll, totalAll };
  }

  /**
   * 已入库记录里最新一条的时间（毫秒）。
   *
   * 用来给水位做体检：正常情况下水位一定 ≥ 这个值；
   * 水位比它还新说明中间有变更从没被拉取过（旧水位被误推进），增量同步需要把窗口拉回来。
   */
  async getNewestChangeTime(): Promise<number | undefined> {
    const rows = await this.ctx.database.get("sync_logs", {}, {
      fields: ["timestamp"],
      sort: { timestamp: "desc" },
      limit: 1,
    });
    const raw = rows[0]?.timestamp;
    if (!raw) return undefined;
    const time = Date.parse(raw);
    return Number.isFinite(time) ? time : undefined;
  }

  /** 单条详情（含已缓存的 diff） */
  async getChange(id: string): Promise<SyncLogRow | undefined> {
    const rows = await this.ctx.database.get("sync_logs", { id });
    return rows[0];
  }

  async saveDiffHtml(id: string, html: string): Promise<void> {
    await this.ctx.database.set("sync_logs", { id }, { diffHtml: html });
  }

  async clearChanges(): Promise<number> {
    const result = await this.ctx.database.remove("sync_logs", {});
    this.writtenSinceTrim = 0;
    return result?.removed ?? 0;
  }
  /** 超出上限时删掉最旧的记录 */
  async trimChanges(max: number): Promise<number> {
    if (this.writtenSinceTrim < TRIM_EVERY) return 0;
    this.writtenSinceTrim = 0;

    // 防御：配置异常（NaN / 负数 / 过小）时不要误删全部记录
    const limit = Number.isFinite(max) ? Math.max(200, Math.floor(max)) : 5000;

    const rows = await this.ctx.database.get("sync_logs", {}, [
      "id",
      "timestamp",
    ]);
    const overflow = rows.length - limit;
    if (overflow <= 0) return 0;

    rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const ids = rows.slice(0, overflow).map((row) => row.id);
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      await this.ctx.database.remove("sync_logs", {
        id: { $in: ids.slice(i, i + WRITE_CHUNK) },
      });
    }
    logger.debug(`[同步任务] 已清理 ${ids.length} 条过期更改记录`);
    return ids.length;
  }

  // ---------------------------------------------------------------- 图片指纹

  async countImages(): Promise<number> {
    if (this.imageCount !== undefined) return this.imageCount;
    const rows = await this.ctx.database.get("sync_images", {}, ["title"]);
    this.imageCount = rows.length;
    return this.imageCount;
  }

  /** 一次取回全部指纹（几百条量级，够轻） */
  async loadImageIndex(): Promise<Map<string, SyncImageFingerprint>> {
    const rows = await this.ctx.database.get("sync_images", {});
    this.imageCount = rows.length;
    return new Map(rows.map((row) => [row.title, row]));
  }

  async upsertImages(rows: SyncImageFingerprint[]): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      await this.ctx.database.upsert("sync_images", rows.slice(i, i + WRITE_CHUNK));
    }
    this.imageCount = undefined;
  }

  /** 缓存失效（图片表被外部改动时用） */
  invalidateImageCount(): void {
    this.imageCount = undefined;
  }
}
