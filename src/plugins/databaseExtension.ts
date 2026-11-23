import { Context } from "koishi";

declare module "koishi" {
  interface Tables {
    wikipages: WikiPages;
    oniaimemory: OniAiMemory;
    sync_logs: SyncLogRow;
    sync_config: SyncConfigRow;
    sync_images: SyncImageRow;
  }
}

export interface WikiPages {
  id: number;
  title: string;
  pinyin_full: string;
  pinyin_first: string;
  contributor?: string;
  change_time?: string;
}

/**
 * `.ai` 的短期记忆落库表。
 *
 * 记忆本身很轻（每轮约 1KB），但**不能只放内存**：Koishi 一重启（部署、HMR、崩溃重启）
 * 群里的追问上下文就断了，用户会看到「刚问过电解器，接着问耗电多少却说未提及」。
 */
export interface OniAiMemory {
  /** 主键：`平台:频道:用户` 或 `topic:平台:频道` */
  id: string;
  /** JSON 序列化的 MemoryTurn[] */
  payload: string;
  /** 最近一次写入的毫秒时间戳，用于过期清理 */
  updated_at: number;
}

/**
 * 最近更改记录（控制台「同步运维」页面展示，条数上限见 `syncLogLimit`）。
 *
 * `id` 直接用 MediaWiki 的 `rcid`，天然去重：同一轮重复拉取不会写两遍。
 */
export interface SyncLogRow {
  /** rcid 字符串形式 */
  id: string;
  title: string;
  user: string;
  /** ISO 8601 时间串，字典序即时间序 */
  timestamp: string;
  comment: string;
  /** 新长度 - 旧长度 */
  sizeDiff: number;
  /** 缓存的 diff HTML（点击详情时按需抓取并落库） */
  diffHtml: string;
  /** 修订 id 与父修订 id，用于按需请求 diff */
  revid: string;
  parentid: string;
  /** 命名空间编号，0 为主命名空间 */
  ns: number;
}

/** 同步配置键值对（`last_sync_time` / `cron_schedule` …） */
export interface SyncConfigRow {
  key: string;
  value: string;
}

/** 已同步图片的指纹，用于增量比对 */
export interface SyncImageRow {
  /** 页面标题，如 `File:Icon Building.png` */
  title: string;
  /** 源站 imageinfo 的 timestamp */
  timestamp: string;
  /** 源站 sha1 */
  sha1: string;
  /** 最近一次成功同步（含「内容一致」）的毫秒时间戳，0 表示尚未核验 */
  synced_at: number;
}

export class DatabaseExtension {
  public static readonly inject = ["database"];

  constructor(ctx: Context) {
    ctx.model.extend("wikipages", {
      id: "integer",
      title: "string",
      pinyin_full: "string",
      pinyin_first: "string",
      contributor: "string",
      change_time: "string",
    });

    ctx.model.extend(
      "oniaimemory",
      {
        id: "string",
        payload: "text",
        updated_at: "integer",
      },
      { primary: "id" },
    );

    ctx.model.extend(
      "sync_logs",
      {
        id: "string",
        title: "string",
        user: "string",
        timestamp: "string",
        comment: "string",
        sizeDiff: "integer",
        diffHtml: "text",
        revid: "string",
        parentid: "string",
        ns: "integer",
      },
      { primary: "id" },
    );

    ctx.model.extend(
      "sync_config",
      {
        key: "string",
        value: "text",
      },
      { primary: "key" },
    );

    ctx.model.extend(
      "sync_images",
      {
        title: "string",
        timestamp: "string",
        sha1: "string",
        synced_at: "integer",
      },
      { primary: "title" },
    );
  }
}
