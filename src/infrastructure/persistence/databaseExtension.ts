import { Context } from "koishi";

declare module "koishi" {
  interface Tables {
    wikipages: WikiPages;
    sync_logs: SyncLogRow;
    sync_config: SyncConfigRow;
    sync_images: SyncImageRow;
    sync_ignore: SyncIgnoreRow;
    sync_runs: SyncRunRow;
    sync_run_items: SyncRunItemRow;
    sync_run_logs: SyncRunLogRow;
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

/**
 * 数据库驱动的忽略列表（`sync.ignore.*` 命令 / 控制台「忽略规则」页维护）。
 *
 * `name` 保留用户原始写法用于展示，`normalized` 存归一化后的值用于查重与精确检索：
 * 数据库层做大小写/下划线不敏感匹配需要驱动特性，这里用一列冗余换可移植性。
 */
export interface SyncIgnoreRow {
  id: number;
  /** 'page' | 'image' | 'module' */
  type: string;
  name: string;
  normalized: string;
  reason: string;
  /** 创建时间（毫秒时间戳） */
  createdAt: number;
}

/** 一次同步任务（任务卡片点开后的「本次运行」） */
export interface SyncRunRow {
  /** `${taskId}-${startedAt}-${随机串}` */
  id: string;
  taskId: string;
  /** 触发方式：cron / console / command / 具体命令名 */
  trigger: string;
  /** 'running' | 'completed' | 'stopped' | 'failed' */
  state: string;
  startedAt: number;
  /** 0 表示尚未结束 */
  finishedAt: number;
  /** 结束摘要或失败原因 */
  message: string;
  total: number;
  synced: number;
  skipped: number;
  failed: number;
}

/** 条目级结果：成功 / 跳过 / 失败各自的原因 */
export interface SyncRunItemRow {
  /** `${runId}#${seq}`：字典序即写入顺序 */
  id: string;
  runId: string;
  title: string;
  /** 'synced' | 'skipped' | 'failed' */
  action: string;
  reason: string;
  at: number;
}

/** 任务运行期间的日志流（每轮最多保留 syncTaskLogLimit 条） */
export interface SyncRunLogRow {
  /** `${runId}#${seq}`：字典序即写入顺序，裁剪时不必额外排序字段 */
  id: string;
  runId: string;
  /** 'info' | 'warn' | 'error' */
  level: string;
  message: string;
  at: number;
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

    ctx.model.extend(
      "sync_ignore",
      {
        id: "unsigned",
        type: "string",
        name: "string",
        normalized: "string",
        reason: "string",
        createdAt: "integer",
      },
      { primary: "id", autoInc: true },
    );

    ctx.model.extend(
      "sync_runs",
      {
        id: "string",
        taskId: "string",
        trigger: "string",
        state: "string",
        startedAt: "integer",
        finishedAt: "integer",
        message: "text",
        total: "integer",
        synced: "integer",
        skipped: "integer",
        failed: "integer",
      },
      { primary: "id" },
    );

    ctx.model.extend(
      "sync_run_items",
      {
        /** `${runId}#${seq}`：自带顺序，批量 upsert 无需回读自增主键 */
        id: "string",
        runId: "string",
        title: "string",
        action: "string",
        reason: "text",
        at: "integer",
      },
      { primary: "id" },
    );

    ctx.model.extend(
      "sync_run_logs",
      {
        /** `${runId}#${seq}`：字典序即写入顺序，裁剪时不必额外排序字段 */
        id: "string",
        runId: "string",
        level: "string",
        message: "text",
        at: "integer",
      },
      { primary: "id" },
    );
  }
}
