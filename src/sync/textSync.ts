import { createHash } from "node:crypto";
import { sleep, withRetry } from "../utils/async";
import { extractPlainText, type TableMode } from "../utils/renderText";
import { getErrorMessage, logger } from "../utils/tools";
import type { VectorIndexer } from "../services/vectorService";

/**
 * `wikitexts` 表的一行（AI 检索用的纯文本）。
 * 这里只声明本模块用到的字段，避免和 Koishi 的表类型强耦合。
 */
interface StoredText {
  id: string;
  title: string;
  pageid?: number;
  revid?: number;
  hash: string;
  text: string;
  updated_at: string;
}

/** 本模块需要的数据库能力（最小接口） */
export interface TextDatabase {
  get<T = unknown>(table: string, query: object): Promise<T[]>;
  upsert(table: string, data: object | object[]): Promise<unknown>;
}

/** 本模块需要的 HTTP 能力（`ctx.http` 结构上兼容） */
export interface TextHttp {
  get<T = any>(
    url: string,
    config?: {
      params?: Record<string, unknown>;
      headers?: Record<string, string>;
      timeout?: number;
    },
  ): Promise<T>;
}

/**
 * 本模块需要的 Wiki 客户端能力（`wikiBot.getBWikiBot()` 结构上兼容）。
 *
 * 优先用它做 `action=parse`：mwn 会自动带上 bwiki 需要的 `Referer` 与登录 Cookie，
 * 而裸 `ctx.http` 不带 `Referer` 时会被 WAF 以 **HTTP 567** 拦掉。
 */
export interface TextBot {
  request(params: Record<string, unknown>): Promise<any>;
}

export interface TextSyncOptions {
  /** BWiki 的 api.php 地址 */
  apiUrl: string;
  /** 页面链接前缀，用于给检索结果生成可点击来源 */
  pageUrlBase: string;
  /** 正文表格处理方式 */
  tableMode: TableMode;
  /** 单页最多保留的字数 */
  maxLength: number;
  /** 批量抓取的页间间隔（毫秒） */
  interval: number;
  /** 单次请求超时（毫秒） */
  timeout: number;
  userAgent: string;
  /** 本地缓存为空时，最多从 BWiki 枚举多少个页面 */
  maxPages: number;
}

export type TextSyncReason = "synced" | "unchanged" | "empty" | "missing" | "failed";

export interface TextSyncResult {
  success: boolean;
  reason: TextSyncReason;
  message?: string;
}

export interface TextSyncSummary {
  total: number;
  synced: number;
  unchanged: number;
  /** 页面在 bwiki 上不存在（missingtitle），不算失败 */
  missing: number;
  failed: number;
}

export interface TextSyncDependencies {
  /** 兜底通道：没有 wikiBot 时用它（会自动补 Referer，避免 567） */
  http?: TextHttp;
  /**
   * 首选通道：已登录的 bwiki 客户端（mwn），自带 Referer / Cookie / 重试。
   *
   * 用**惰性 getter** 而不是直接传实例：插件构造时 `wikiBot` 往往还没完成登录，
   * 直接取值会永远是 `undefined`，等真正发请求时再取才拿得到。
   */
  bot?: () => TextBot | undefined;
  database: TextDatabase;
  /** 向量库（可选）：提供时页面文本变化后会自动重建该页的向量 */
  vector?: VectorIndexer;
  options?: Partial<TextSyncOptions>;
}

const DEFAULT_OPTIONS: TextSyncOptions = {
  apiUrl: "https://wiki.biligame.com/oni/api.php",
  pageUrlBase: "https://wiki.biligame.com/oni/",
  tableMode: "flatten",
  maxLength: 20000,
  interval: 300,
  timeout: 30000,
  userAgent: "OniSyncBot/1.0 (https://klei.vip; Charles@klei.vip)",
  maxPages: 5000,
};

interface ParseApiResponse {
  error?: { code?: string; info?: string };
  parse?: {
    title?: string;
    pageid?: number;
    revid?: number;
    text?: string | { "*"?: string };
  };
}

interface AllPagesResponse {
  error?: { code?: string; info?: string };
  continue?: { apcontinue?: string };
  query?: { allpages?: Array<{ title?: string }> };
}

interface ParseResult {
  html: string;
  resolvedTitle?: string;
  pageid?: number;
  revid?: number;
}

/**
 * 把 BWiki `action=parse&prop=text` 的**渲染结果**抽成纯文本并落库。
 *
 * 与 `pageSync` 的分工：
 * - `PageSyncer` 负责 Wikitext 源码的 GG → bwiki 同步；
 * - 本类在同步成功之后，回到 bwiki 取「渲染后的正文」，剔除表格噪音/脚本，
 *   写入 `wikitexts` 表并（可选）更新向量索引。
 *
 * 传给 AI 的永远只有这里的纯文本，Wikitext 源码不会进入检索链路。
 */
export class RenderedTextSyncer {
  private readonly http?: TextHttp;
  private readonly bot?: () => TextBot | undefined;
  private readonly database: TextDatabase;
  private readonly vector?: VectorIndexer;
  private readonly options: TextSyncOptions;

  constructor(deps: TextSyncDependencies) {
    this.http = deps.http;
    this.bot = deps.bot;
    this.database = deps.database;
    this.vector = deps.vector;
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
  }

  /** 页面在 bwiki 上的访问地址（用于回答里的「资料来源」） */
  pageUrl(title: string): string {
    return buildPageUrl(this.options.pageUrlBase, title);
  }

  /**
   * 抓取并保存单个页面的渲染文本。
   *
   * 文本的 sha1 与库中一致时直接返回 `unchanged`，
   * 既省掉一次 Embedding，也避免每小时的增量任务重复写索引。
   */
  async syncOne(title: string): Promise<TextSyncResult> {
    const pageTitle = title.trim();
    if (!pageTitle) return { success: false, reason: "empty", message: "标题为空" };

    try {
      const parsed = await this.fetchRenderedHtml(pageTitle);
      if (!parsed) {
        logger.debug(`[textSync] ${pageTitle}：bwiki 上不存在该页面，跳过`);
        return { success: false, reason: "missing" };
      }

      const text = extractPlainText(parsed.html, {
        tableMode: this.options.tableMode,
        maxLength: this.options.maxLength,
      });
      if (!text) {
        logger.warn(`[textSync] ${pageTitle}：抽出正文为空，跳过`);
        return { success: false, reason: "empty" };
      }

      const hash = hashText(text);
      const existing = await this.database.get<StoredText>("wikitexts", {
        id: pageTitle,
      });
      if (existing[0]?.hash === hash) {
        logger.debug(`[textSync] ${pageTitle}：正文未变化，跳过`);
        return { success: true, reason: "unchanged" };
      }

      const record: StoredText = {
        id: pageTitle,
        title: parsed.resolvedTitle || pageTitle,
        pageid: parsed.pageid,
        revid: parsed.revid,
        hash,
        text,
        updated_at: new Date().toISOString(),
      };
      await this.database.upsert("wikitexts", [record]);
      logger.info(
        `[textSync] ${pageTitle}：正文已入库（${text.length} 字，${hash.slice(0, 8)}）`,
      );

      if (this.vector) {
        try {
          await this.vector.indexPage({
            id: record.id,
            title: record.title,
            url: this.pageUrl(pageTitle),
            text,
          });
        } catch (error) {
          logger.warn(
            `[textSync] ${pageTitle}：向量化失败（文本已入库）：${getErrorMessage(error)}`,
          );
          return {
            success: true,
            reason: "synced",
            message: "文本已入库，但向量化失败",
          };
        }
      }

      return { success: true, reason: "synced" };
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error(`[textSync] ${pageTitle}：抓取渲染文本失败：${message}`);
      return { success: false, reason: "failed", message };
    }
  }

  /** 批量抓取（按配置的间隔串行执行，避免把小机器和 bwiki 打满） */
  async syncMany(titles: string[]): Promise<TextSyncSummary> {
    const summary: TextSyncSummary = {
      total: titles.length,
      synced: 0,
      unchanged: 0,
      missing: 0,
      failed: 0,
    };

    for (let index = 0; index < titles.length; index++) {
      const result = await this.syncOne(titles[index]);
      if (result.success && result.reason === "synced") summary.synced++;
      else if (result.success && result.reason === "unchanged") summary.unchanged++;
      else if (result.reason === "missing") summary.missing++;
      else summary.failed++;

      const processed = index + 1;
      if (processed % 20 === 0 || processed === titles.length) {
        logger.info(
          `[textSync] 进度 ${processed}/${titles.length}：新增/更新 ${summary.synced}，未变 ${summary.unchanged}，页面不存在 ${summary.missing}，失败 ${summary.failed}`,
        );
      }

      if (processed < titles.length && this.options.interval > 0) {
        await sleep(this.options.interval);
      }
    }

    return summary;
  }

  /**
   * 对本地缓存的全部页面执行一次渲染文本抓取（首次部署 / 全量重建时使用）。
   *
   * 本地 `wikipages` 为空（还没执行过 `update`）时，直接向 BWiki 的 `allpages`
   * 枚举主命名空间页面——`ai.sync` 因此不依赖页面缓存也能跑起来。
   */
  async syncAll(): Promise<TextSyncSummary> {
    let titles = (
      await this.database.get<{ title: string }>("wikipages", {})
    ).map((page) => page.title);

    if (titles.length === 0) {
      logger.warn(
        "[textSync] 本地页面缓存为空，改为从 BWiki 的 allpages 枚举页面（建议之后执行 update 补全缓存）",
      );
      titles = await this.listAllPageTitles();
    }

    logger.info(`[textSync] 开始抓取 ${titles.length} 个页面的渲染文本`);
    return this.syncMany(titles);
  }

  // ---------------------------------------------------------------- 内部实现

  /**
   * 统一的 API 请求入口。
   *
   * 首选已登录的 bwiki 客户端（mwn，自带 Referer / Cookie，且与 `sync.*` 走同一条链路），
   * 没有就退回 `ctx.http` 并**手动补上 Referer**——缺 Referer 会被 bwiki 的 WAF 直接 567。
   */
  private async apiRequest<T>(params: Record<string, unknown>): Promise<T> {
    const payload = { ...params, format: "json" };

    return withRetry(
      async () => {
        const bot = this.bot?.();
        if (bot) {
          return (await bot.request(payload)) as T;
        }
        if (!this.http) {
          throw new Error(
            "既没有可用的 wikiBot 也没有 http 服务，无法请求 BWiki（请检查登录与 @koishijs/plugin-http）",
          );
        }
        return this.http.get<T>(this.options.apiUrl, {
          params: payload,
          headers: {
            "User-Agent": this.options.userAgent,
            Referer: this.options.pageUrlBase,
          },
          timeout: this.options.timeout,
        });
      },
      {
        attempts: 3,
        delayMs: 1500,
        onRetry: (error, attempt, attempts) =>
          logger.warn(
            `[textSync] 请求 BWiki 失败，重试中 (${attempt}/${attempts})：${getErrorMessage(error)}`,
          ),
      },
    );
  }

  /** 通过 MediaWiki `list=allpages` 枚举主命名空间页面标题（含 continue 翻页） */
  private async listAllPageTitles(): Promise<string[]> {
    const titles: string[] = [];
    let apcontinue: string | undefined;

    while (titles.length < this.options.maxPages) {
      const data = await this.apiRequest<AllPagesResponse>({
        action: "query",
        list: "allpages",
        apnamespace: 0,
        aplimit: "max",
        formatversion: 2,
        ...(apcontinue ? { apcontinue } : {}),
      });

      if (data?.error) {
        throw new Error(
          `allpages 查询报错：${data.error.code ?? "unknown"} ${data.error.info ?? ""}`.trim(),
        );
      }

      for (const page of data?.query?.allpages ?? []) {
        if (page.title && titles.length < this.options.maxPages) {
          titles.push(page.title);
        }
      }

      apcontinue = data?.continue?.apcontinue;
      if (!apcontinue || titles.length >= this.options.maxPages) break;
    }

    logger.info(`[textSync] allpages 枚举到 ${titles.length} 个页面`);
    return titles;
  }

  private async fetchRenderedHtml(title: string): Promise<ParseResult | null> {
    const data = await this.apiRequest<ParseApiResponse>({
      action: "parse",
      page: title,
      prop: "text|revid",
      formatversion: 2,
      redirects: 1,
      disableeditsection: 1,
      disabletoc: 1,
      disablelimitreport: 1,
    });

    if (data?.error) {
      // 页面不存在是正常情况（本地缓存可能包含已删除页面），单独归类为 missing
      if (data.error.code === "missingtitle") return null;
      throw new Error(
        `解析接口报错：${data.error.code ?? "unknown"} ${data.error.info ?? ""}`.trim(),
      );
    }

    const parse = data?.parse;
    const html =
      typeof parse?.text === "string" ? parse.text : parse?.text?.["*"] ?? "";
    if (!parse || !html) return null;

    return {
      html,
      resolvedTitle: parse.title,
      pageid: parse.pageid,
      revid: parse.revid,
    };
  }
}

function hashText(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** 拼接 BWiki 页面地址（站内链接约定：空格换成下划线） */
export function buildPageUrl(pageUrlBase: string, title: string): string {
  return `${pageUrlBase}${encodeURIComponent(title.trim().replace(/ /g, "_"))}`;
}
