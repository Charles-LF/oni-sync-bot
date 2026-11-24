/**
 * 同步状态仓储端口（应用层）：增量同步用例需要的水位 / 变更记录 / 图片指纹能力。
 *
 * 实现见 `infrastructure/persistence/syncRepository.ts`。
 * 用例只依赖这个接口，单测里可以直接塞内存实现，不必拉起数据库。
 */

export interface SyncChangeRecord {
  /** MediaWiki 的 rcid（天然去重） */
  id: string;
  title: string;
  user: string;
  timestamp: string;
  comment: string;
  sizeDiff: number;
  revid?: string;
  parentid?: string;
  ns?: number;
}

/** 图片指纹（与 `sync_images` 表结构一致） */
export interface SyncImageFingerprint {
  /** 页面标题，如 `File:Icon Building.png` */
  title: string;
  /** 源站 imageinfo 的 timestamp */
  timestamp: string;
  /** 源站 sha1 */
  sha1: string;
  /** 最近一次成功同步（含「内容一致」）的毫秒时间戳 */
  synced_at: number;
}

export interface SyncStatePort {
  /** 上次成功同步的时间（毫秒）；从未同步过返回 undefined */
  getLastSyncTime(): number | undefined;
  /** 已入库记录里最新一条的时间（毫秒），用于水位体检 */
  getNewestChangeTime(): Promise<number | undefined>;
  /** 批量写入变更记录，按 `id` 去重，返回真正新插入的条数 */
  saveChanges(records: SyncChangeRecord[]): Promise<number>;
  /** 超出上限时删掉最旧的记录 */
  trimChanges(max: number): Promise<number>;
  setLastSyncTime(time: number | string): Promise<void>;
  setConfig(key: string, value: string): Promise<void>;
  /** 一次取回全部图片指纹 */
  loadImageIndex(): Promise<Map<string, SyncImageFingerprint>>;
  upsertImages(rows: SyncImageFingerprint[]): Promise<void>;
}
