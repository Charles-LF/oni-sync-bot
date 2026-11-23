import { Mwn } from "mwn";
import type { PageSyncer, SyncNotifyItem } from "./pageSync";
import type { ImageSyncer } from "./imgSync";
import type {
  SyncChangeRecord,
  SyncRepository,
} from "../services/syncRepository";
import type {
  ProgressReporter,
  RunToken,
  SyncRunSummary,
} from "../services/syncTaskManager";
import { getErrorMessage, logger, stripImagePrefix } from "../utils/tools";
import { sleep } from "../utils/async";

export interface IncrementalSyncOptions {
  /** 不参与同步的页面 */
  ignoredPages: Set<string>;
  /** 文件命名空间前缀，如 `File:` */
  fileNamespacePrefix: string;
  /** 写进 bwiki 编辑摘要里的操作者名 */
  defaultUser: string;
  /** diff/编辑摘要的最大长度 */
  maxLogRecords: number;
  /** 首次运行（无水位）向前回溯的小时数 */
  fallbackHours: number;
  /** recentchanges 起始时间向前偏移的毫秒数，抵消 MediaWiki 写入延迟 */
  overlapMs: number;
  /** 单轮最多处理多少个页面，防止长时间积压一次跑太久 */
  maxPagesPerRun: number;
  /** 本轮最多同步多少张图片 */
  maxImagesPerRun: number;
  /** 是否检查图片 */
  checkImages: boolean;
  /** 每个页面 / 图片之间的间隔 */
  intervalSuccess: number;
  intervalFailed: number;
}

const DEFAULT_OPTIONS: IncrementalSyncOptions = {
  ignoredPages: new Set(["教程", "MediaWiki:Common.css", "首页", "Main Page"]),
  fileNamespacePrefix: "File:",
  defaultUser: "同步坤器人",
  maxLogRecords: 5000,
  fallbackHours: 3,
  overlapMs: 10_000,
  maxPagesPerRun: 300,
  maxImagesPerRun: 100,
  checkImages: true,
  intervalSuccess: 500,
  intervalFailed: 1000,
};

export interface IncrementalSyncDeps {
  source: Mwn;
  target: Mwn;
  pages: PageSyncer;
  images: ImageSyncer;
  repo: SyncRepository;
  /** 同步成功后一次性回调（群通知） */
  notify?: (items: SyncNotifyItem[]) => void;
}

export interface IncrementalSyncResult extends SyncRunSummary {
  from: string;
  to: string;
  changes: number;
  pages: number;
  images: number;
  imagesSynced: number;
}

interface RecentChangeItem {
  rcid?: number;
  revid?: number;
  old_revid?: number;
  parentid?: number;
  pageid?: number;
  title?: string;
  user?: string;
  timestamp?: string;
  comment?: string;
  oldlen?: number;
  newlen?: number;
  ns?: number;
  type?: string;
}

interface AllImageItem {
  title: string;
  timestamp?: string;
}

interface ImageInfoItem {
  timestamp?: string;
  sha1?: string;
}

/** `imageinfo` 批量查询的返回结构（只声明用到的字段） */
interface ImageInfoPage {
  title?: string;
  missing?: boolean;
  imageinfo?: ImageInfoItem[];
}

/** 图片批量查询的批大小：50 个标题拼成一条 URL 还算安全 */
const IMAGE_INFO_BATCH = 50;

/**
 * 基于变更检测的增量同步。
 *
 * 与旧的「每次回溯 3 小时」相比，这里用持久化水位（`last_sync_time`）：
 * 只处理上次成功之后新产生的编辑；水位在任务**完整跑完**后才推进，
 * 中途停止不会漏掉数据（下一次会重新覆盖这段区间，靠 rcid 去重 + 内容比对降到几乎零成本）。
 */
export async function runIncrementalSync(
  deps: IncrementalSyncDeps,
  token: RunToken,
  report: ProgressReporter,
  options: Partial<IncrementalSyncOptions> = {},
): Promise<IncrementalSyncResult> {
  const opts: IncrementalSyncOptions = { ...DEFAULT_OPTIONS, ...options };
  const startedAt = Date.now();
  const now = new Date();
  const lastSync = deps.repo.getLastSyncTime();
  const from = new Date(
    lastSync !== undefined
      ? lastSync - opts.overlapMs
      : now.getTime() - opts.fallbackHours * 3600_000,
  );

  // 水位比「现在」还新（时钟回拨 / 手改配置）时，回溯到 fallback 窗口，避免空转
  const effectiveFrom = from.getTime() > now.getTime() ? new Date(now.getTime() - opts.fallbackHours * 3600_000) : from;

  logger.info(
    `[增量更新流程] ⏰ 同步区间 ${effectiveFrom.toISOString()} → ${now.toISOString()}` +
      `（${lastSync === undefined ? "首次运行" : `水位 ${new Date(lastSync).toISOString()}`}）`,
  );

  report({
    phase: "拉取变更",
    current: 0,
    total: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    message: "正在拉取最近更改…",
  });

  const titles = new Map<string, RecentChangeRecord>();
  let changes = 0;
  let stored = 0;

  const queryGen = deps.source.continuedQueryGen({
    action: "query",
    list: "recentchanges",
    // 正序（旧→新）：截断时才可以用「最后处理到的时间」当游标，保证下一轮接着走
    rcstart: effectiveFrom.toISOString(),
    rcend: now.toISOString(),
    rcdir: "newer",
    rctype: "edit|new",
    rcnamespace: 0,
    rclimit: "max",
    rcprop: "title|user|comment|timestamp|ids|sizes",
  });

  for await (const res of queryGen) {
    await token.checkpoint();
    const batch: RecentChangeItem[] = res.query?.recentchanges || [];
    const records: SyncChangeRecord[] = [];

    for (const item of batch) {
      const title = item.title?.trim();
      if (!title) continue;
      if (item.ns !== undefined && item.ns !== 0) continue;
      if (!item.rcid || !item.revid) continue;
      // 被删除的页面没法同步，跳过但已记录在 sync_logs 之外
      if (opts.ignoredPages.has(title)) continue;

      changes++;
      records.push({
        id: String(item.rcid),
        title,
        user: item.user || "未知",
        timestamp: item.timestamp || new Date().toISOString(),
        comment: item.comment || "",
        sizeDiff: (item.newlen ?? 0) - (item.oldlen ?? 0),
        revid: String(item.revid),
        parentid: String(item.parentid ?? item.old_revid ?? ""),
        ns: item.ns ?? 0,
      });

      const existing = titles.get(title);
      // 正序遍历：第一次出现的即最早那次编辑，用它做通知元信息与游标
      if (!existing) {
        titles.set(title, {
          user: item.user || "未知",
          timestamp: item.timestamp || "",
          comment: item.comment || "",
          pageid: item.pageid ?? 0,
        });
      }
    }

    if (records.length > 0) {
      stored += await deps.repo.saveChanges(records);
    }
    report({
      phase: "拉取变更",
      current: changes,
      total: 0,
      message: `已拉取 ${changes} 条变更（新增 ${stored} 条记录）`,
    });
  }

  if (stored > 0) {
    await deps.repo.trimChanges(opts.maxLogRecords);
  }

  logger.info(
    `[增量更新流程] 📥 拉取完成：${changes} 条变更 / ${titles.size} 个页面（新入库 ${stored} 条）`,
  );

  // ------------------------------------------------------------ 同步页面
  const allTitles = [...titles.keys()];
  const pageTitles = allTitles.slice(0, opts.maxPagesPerRun);
  const truncated = pageTitles.length < allTitles.length;
  const syncedItems: SyncNotifyItem[] = [];
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  report({
    phase: "同步页面",
    current: 0,
    total: pageTitles.length,
    synced,
    skipped,
    failed,
    message: pageTitles.length
      ? `准备同步 ${pageTitles.length} 个页面`
      : "本轮没有页面需要同步",
  });

  for (let i = 0; i < pageTitles.length; i++) {
    await token.checkpoint();
    const title = pageTitles[i];
    const meta = titles.get(title);
    try {
      // 先把新页面登记进 wikipages，`.x` 查询才能立刻查到
      await deps.pages.ensurePage(meta?.pageid ?? 0, title);
      const result = await deps.pages.syncOne(title, opts.defaultUser);
      if (result.success) {
        if (result.reason === "synced") {
          synced++;
          syncedItems.push({
            title,
            type: "page",
            user: meta?.user,
            timestamp: meta?.timestamp,
            comment: meta?.comment,
          });
        } else {
          skipped++;
        }
        // 只要有变更记录就更新贡献者（内容没变也说明有人动过）
        if (meta?.user && meta.user !== "未知") {
          await deps.pages.updateContributor(title, meta.user, meta.timestamp);
        }
      } else {
        failed++;
      }
    } catch (error) {
      failed++;
      logger.error(`[增量更新流程] ❌ 同步 ${title} 失败：${getErrorMessage(error)}`);
    }

    report({
      phase: "同步页面",
      current: i + 1,
      total: pageTitles.length,
      synced,
      skipped,
      failed,
      message: `${i + 1}/${pageTitles.length} · ${title}`,
    });
    await sleep(failed > 0 ? opts.intervalFailed : opts.intervalSuccess);
  }

  if (truncated) {
    logger.warn(
      `[增量更新流程] 本轮只处理了 ${pageTitles.length}/${allTitles.length} 个页面（受 maxPagesPerRun 限制），` +
        `水位停在游标处，剩余页面下一轮继续`,
    );
  }

  // ------------------------------------------------------------ 检查图片
  let images = 0;
  let imagesSynced = 0;
  if (opts.checkImages) {
    await token.checkpoint();
    report({
      phase: "检查图片",
      current: 0,
      total: 0,
      synced,
      skipped,
      failed,
      message: "正在比对图片指纹…",
    });
    const imageResult = await runImagePass(deps, token, opts, report, {
      synced,
      skipped,
      failed,
    });
    images = imageResult.checked;
    imagesSynced = imageResult.synced;
    synced += imageResult.synced;
    skipped += imageResult.skipped;
    failed += imageResult.failed;
  }

  // -------------------------------------------------------- 推进水位 / 收尾
  await token.checkpoint();

  /**
   * 被 `maxPagesPerRun` 截断时不能推进到 now，否则没处理的页面就永久漏掉了。
   * 因为变更按时间正序处理，把水位停在「最后处理的那个页面的最早一次编辑」上，
   * 下一轮（含 10 秒重叠）会从这条继续，整体单调前进。
   */
  let watermark: number = now.getTime();
  let truncatedNote = "";
  if (truncated) {
    const lastTitle = pageTitles[pageTitles.length - 1];
    const cursor = Date.parse(titles.get(lastTitle)?.timestamp ?? "");
    if (Number.isFinite(cursor)) {
      watermark = cursor;
      truncatedNote = `；剩余 ${allTitles.length - pageTitles.length} 个页面待下一轮`;
    }
  }
  await deps.repo.setLastSyncTime(watermark);

  const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary =
    `变更 ${changes} 条 / 页面 ${pageTitles.length} 个 / 图片 ${images} 张；` +
    `同步 ${synced}、跳过 ${skipped}、失败 ${failed}，耗时 ${duration}s${truncatedNote}`;
  await deps.repo.setConfig("last_result", summary);

  logger.info(`[增量更新流程] ✅ ${summary}`);

  if (syncedItems.length > 0) {
    deps.notify?.(syncedItems);
  }

  return {
    synced,
    skipped,
    failed,
    message: summary,
    from: effectiveFrom.toISOString(),
    to: new Date(watermark).toISOString(),
    changes,
    pages: pageTitles.length,
    images,
    imagesSynced,
  };
}

interface RecentChangeRecord {
  user: string;
  timestamp: string;
  comment: string;
  pageid: number;
}

interface ImagePassResult {
  checked: number;
  synced: number;
  skipped: number;
  failed: number;
}

/**
 * 图片增量：先用 `allimages` 拿一份「标题 → 源站时间戳」的轻量索引，
 * 与本地指纹比对得到待处理列表，再用 `imageinfo` 批量确认 sha1 / 时间戳。
 *
 * 图片不走 recentchanges，所以这里必须自己发现「新出现的图片」，
 * 否则新上传的文件永远不会被同步。
 */
async function runImagePass(
  deps: IncrementalSyncDeps,
  token: RunToken,
  opts: IncrementalSyncOptions,
  report: ProgressReporter,
  counters: { synced: number; skipped: number; failed: number },
): Promise<ImagePassResult> {
  const index = await deps.repo.loadImageIndex();
  const remote = await listRemoteImages(deps.source, token, report);

  if (remote.size === 0) {
    logger.warn("[增量更新流程] 图片索引获取失败或源站无图片，跳过图片检查");
    return { checked: 0, synced: 0, skipped: 0, failed: 0 };
  }

  const pending: string[] = [];
  for (const [title, timestamp] of remote) {
    const known = index.get(title);
    // 新图片（本地无指纹）或时间戳变了都需要处理
    if (!known || known.timestamp !== timestamp || !known.synced_at) {
      pending.push(title);
    }
  }

  logger.info(
    `[增量更新流程] 🖼️ 图片索引 ${remote.size} 张，待处理 ${pending.length} 张`,
  );

  if (pending.length === 0) {
    return { checked: remote.size, synced: 0, skipped: 0, failed: 0 };
  }

  const target = pending.slice(0, opts.maxImagesPerRun);
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < target.length; i += IMAGE_INFO_BATCH) {
    await token.checkpoint();
    const batch = target.slice(i, i + IMAGE_INFO_BATCH);
    const info = await fetchImageInfo(deps.source, batch);

    for (let j = 0; j < batch.length; j++) {
      const title = batch[j];
      await token.checkpoint();
      const meta = info.get(title);
      if (!meta) {
        // 源站已删除该图片，保持原指纹不动即可
        skipped++;
        continue;
      }

      try {
        const result = await deps.images.syncOne(stripImagePrefix(title));
        if (result.success) {
          if (result.reason === "synced") synced++;
          else skipped++;
          await deps.repo.upsertImages([
            {
              title,
              timestamp: meta.timestamp || remote.get(title) || "",
              sha1: meta.sha1 || "",
              synced_at: Date.now(),
            },
          ]);
        } else {
          failed++;
        }
      } catch (error) {
        failed++;
        logger.error(
          `[增量更新流程] ❌ 同步图片 ${title} 失败：${getErrorMessage(error)}`,
        );
      }

      report({
        phase: "检查图片",
        current: i + j + 1,
        total: target.length,
        synced: counters.synced + synced,
        skipped: counters.skipped + skipped,
        failed: counters.failed + failed,
        message: `${stripImagePrefix(title)}（${synced} 已更新 / ${skipped} 跳过 / ${failed} 失败）`,
      });
      await sleep(failed > 0 ? opts.intervalFailed : opts.intervalSuccess);
    }
  }

  return { checked: remote.size, synced, skipped, failed };
}

/** 列出源站全部图片及其时间戳（只有标题与时间，很轻） */
async function listRemoteImages(
  source: Mwn,
  token: RunToken,
  report: ProgressReporter,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const queryGen = source.continuedQueryGen({
      action: "query",
      list: "allimages",
      ailimit: "max",
      aidir: "ascending",
      ainamespace: 6,
      aiprop: "timestamp",
    });

    for await (const res of queryGen) {
      await token.checkpoint();
      const items = (res.query?.allimages || []) as AllImageItem[];
      for (const item of items) {
        if (!item.title) continue;
        result.set(item.title, item.timestamp || "");
      }
      report({
        phase: "检查图片",
        current: result.size,
        total: 0,
        message: `已读取 ${result.size} 张图片的索引`,
      });
    }
  } catch (error) {
    logger.warn(`[增量更新流程] 读取图片列表失败：${getErrorMessage(error)}`);
  }
  return result;
}

/** 批量拿 imageinfo 的 timestamp / sha1 */
async function fetchImageInfo(
  source: Mwn,
  titles: string[],
): Promise<Map<string, ImageInfoItem>> {
  const result = new Map<string, ImageInfoItem>();
  if (titles.length === 0) return result;

  try {
    const res = await source.request({
      action: "query",
      format: "json",
      formatversion: "2",
      titles: titles.join("|"),
      prop: "imageinfo",
      iiprop: "timestamp|sha1",
    });

    const pages = (res.query?.pages || []) as ImageInfoPage[];
    for (const page of pages) {
      if (!page?.title) continue;
      const info = page.imageinfo?.[0];
      if (!info) continue;
      result.set(page.title, info);
    }
  } catch (error) {
    logger.warn(`[增量更新流程] 批量获取图片信息失败：${getErrorMessage(error)}`);
  }

  return result;
}
