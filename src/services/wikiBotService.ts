import { Context, Service } from "koishi";
import type { AccountConfig } from "../config";
import { Mwn } from "mwn";
import { logger, getErrorMessage } from "../utils/tools";
import { withRetry } from "../utils/async";
import { extractPlainText } from "../utils/renderText";
import { createReloginAwareProxy } from "./reloginAwareProxy";

declare module "koishi" {
  interface Context {
    wikiBot: WikiBotService;
  }
}

export interface ISiteConfig {
  name: string;
  api: string;
  username: string;
  password: string;
  userAgent: string;
}

interface ISitesConfig {
  gg: ISiteConfig;
  bwiki: ISiteConfig;
}

export type WikiSite = "gg" | "bwiki";

export class WikiBotService extends Service {
  public static readonly inject = [];

  private ggbot: Mwn | null = null;
  private bwikibot: Mwn | null = null;
  private botProxies: Record<WikiSite, Mwn | null> = { gg: null, bwiki: null };
  private botConfig: WikiBotServiceConfig;
  private static readonly USER_AGENT = `OniSyncBot/1.0 (https://klei.vip; Charles@klei.vip)`;
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY = 5000;

  /** 给 AI 的正文默认截断长度 */
  private static readonly PAGE_TEXT_LIMIT = 3000;
  /** 正文缓存：TTL + 条目上限（bwiki 有 WAF 限流，同页不重复请求） */
  private static readonly PAGE_TEXT_TTL = 10 * 60 * 1000;
  private static readonly PAGE_TEXT_CACHE_SIZE = 50;

  /** 小写标题 → 正文（约 3 KB/页） */
  private readonly pageTextCache = new Map<
    string,
    { text: string; at: number }
  >();

  constructor(ctx: Context, config: WikiBotServiceConfig) {
    super(ctx, "wikiBot", true);
    this.botConfig = config;
  }

  /** 站点显示名，避免到处写 `site === "gg" ? "WIKIGG" : "bwiki"` */
  private static siteLabel(site: WikiSite): string {
    return site === "gg" ? "WIKIGG" : "bwiki";
  }

  private botOf(site: WikiSite): Mwn | null {
    return site === "gg" ? this.ggbot : this.bwikibot;
  }

  private setBot(site: WikiSite, bot: Mwn | null): void {
    if (site === "gg") {
      this.ggbot = bot;
    } else {
      this.bwikibot = bot;
    }
  }

  private siteConfigOf(site: WikiSite): ISiteConfig {
    const sites = this.getSitesConfig();
    return site === "gg" ? sites.gg : sites.bwiki;
  }

  private getSitesConfig(): ISitesConfig {
    return {
      gg: {
        name: "WIKIGG",
        api: "https://oxygennotincluded.wiki.gg/zh/api.php",
        username: this.botConfig.ggUsername,
        password: this.botConfig.ggPassword,
        userAgent: WikiBotService.USER_AGENT,
      },
      bwiki: {
        name: "bwiki",
        api: "https://wiki.biligame.com/oni/api.php",
        username: this.botConfig.bwikiusername,
        password: this.botConfig.bwikipassword,
        userAgent: WikiBotService.USER_AGENT,
      },
    };
  }

  private async loginWithRetry(siteConfig: ISiteConfig): Promise<Mwn> {
    try {
      return await withRetry(() => this.login(siteConfig), {
        attempts: WikiBotService.MAX_RETRIES,
        delayMs: WikiBotService.RETRY_DELAY,
        onRetry: (error, attempt, attempts) =>
          logger.debug(
            `${siteConfig.name} 登录失败，重试中 (${attempt}/${attempts}): ${getErrorMessage(error)}`,
          ),
      });
    } catch (error) {
      logger.error(`❌ ${siteConfig.name} 登录失败`, getErrorMessage(error));
      throw error;
    }
  }

  private async login(siteConfig: ISiteConfig): Promise<Mwn> {
    const bot = new Mwn({
      apiUrl: siteConfig.api,
      username: siteConfig.username,
      password: siteConfig.password,
      userAgent: siteConfig.userAgent,
      defaultParams: {
        assert: "user",
      },
      maxRetries: 0,
      retryPause: 0,
    });

    if (siteConfig.name === "bwiki") {
      const cookieString =
        "SESSDATA=666; Domain=wiki.biligame.com; Path=/oni; HttpOnly; Secure;";
      bot.cookieJar.setCookie(cookieString, bot.options.apiUrl!, (err) => {
        if (err) {
          logger.warn("bwiki Cookie 注入失败:", err);
        }
      });
      bot.setRequestOptions({
        headers: {
          referer: "https://wiki.biligame.com/oni/",
          "User-Agent": siteConfig.userAgent,
        },
      });
    }

    await bot.login();
    return bot;
  }

  async start() {
    try {
      const ggOk = await this.loginSite("gg");
      const bwikiOk = await this.loginSite("bwiki");

      if (!ggOk && !bwikiOk) {
        logger.error("❌ WikiBotService 初始化失败，两个 Wiki 均无法登录");
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      logger.error("❌ WikiBotService 初始化异常:", errorMsg);
    }
  }

  stop() {
    this.ggbot = null;
    this.bwikibot = null;
    this.botProxies = { gg: null, bwiki: null };
    this.pageTextCache.clear();
  }

  async relogin(): Promise<{ gg: boolean; bwiki: boolean }> {
    const gg = await this.loginSite("gg", true);
    const bwiki = await this.loginSite("bwiki", true);
    return { gg, bwiki };
  }

  /**
   * 确保两个站点都已登录：任一未就绪时先尝试重新登录。
   * 就绪状态属于本服务的职责，调用方只消费结果。
   */
  async ensureReady(): Promise<{ gg: boolean; bwiki: boolean }> {
    if (!this.isGGBotReady() || !this.isBWikiBotReady()) {
      logger.warn("检测到部分机器人未就绪，尝试重新登录...");
      try {
        await this.relogin();
      } catch (error) {
        logger.error("重新登录失败:", getErrorMessage(error));
      }
    }
    return { gg: this.isGGBotReady(), bwiki: this.isBWikiBotReady() };
  }

  /** 登录单个站点；失败不抛错、只返回是否成功（顺序调用以保持原有时序） */
  private async loginSite(site: WikiSite, isRelogin = false): Promise<boolean> {
    const label = WikiBotService.siteLabel(site);
    try {
      this.setBot(site, await this.loginWithRetry(this.siteConfigOf(site)));
      logger.info(`✅ ${label} ${isRelogin ? "重新" : ""}登录成功`);
      return true;
    } catch (error) {
      this.setBot(site, null);
      return false;
    }
  }

  private async reloginSite(site: WikiSite): Promise<void> {
    const label = WikiBotService.siteLabel(site);
    try {
      this.setBot(site, await this.loginWithRetry(this.siteConfigOf(site)));
      logger.info(`✅ ${label} 自动重新登录成功`);
    } catch (error) {
      this.setBot(site, null);
      throw error;
    }
  }

  /** 两个站点是否至少有一个可用（派生状态，不需要手工同步） */
  get isReady(): boolean {
    return this.ggbot !== null || this.bwikibot !== null;
  }

  isGGBotReady(): boolean {
    return this.botOf("gg") !== null;
  }

  isBWikiBotReady(): boolean {
    return this.botOf("bwiki") !== null;
  }

  private createBotProxy(site: WikiSite): Mwn {
    const label = WikiBotService.siteLabel(site);

    return createReloginAwareProxy({
      getBot: () => {
        const bot = this.botOf(site);
        if (!bot) {
          throw new Error(`${label} bot 尚未就绪，请检查登录配置或查看日志`);
        }
        return bot;
      },
      relogin: () => this.reloginSite(site),
      label,
    });
  }

  /** WIKIGG 客户端（透明处理登录过期） */
  getGGBot(): Mwn {
    return this.getBot("gg");
  }

  /** bwiki 客户端（透明处理登录过期） */
  getBWikiBot(): Mwn {
    return this.getBot("bwiki");
  }

  // ------------------------------------------------------- 渲染文本（供 AI 使用）

  /**
   * 取页面**渲染后**的纯文本（`parseTitle`，经 relogin 代理自动重登）。
   * 清洗**不删 `<table>`**：信息框就是 `table.infobox`，数值全在里面。
   * 页面不存在 / 未登录 / 网络失败一律返回 `null`。
   */
  async fetchPagePlainText(
    title: string,
    options: { limit?: number; bypassCache?: boolean } = {},
  ): Promise<string | null> {
    const pageTitle = title.trim();
    if (!pageTitle) return null;

    const key = pageTitle.toLowerCase();
    if (!options.bypassCache) {
      const cached = this.pageTextCache.get(key);
      if (cached && Date.now() - cached.at < WikiBotService.PAGE_TEXT_TTL) {
        logger.debug(`[wikiBot] 命中正文缓存：${pageTitle}`);
        return cached.text;
      }
    }

    if (!this.isBWikiBotReady()) {
      logger.warn(`[wikiBot] bwiki 未登录，无法获取「${pageTitle}」的正文`);
      return null;
    }

    let html: string;
    try {
      html = await this.getBWikiBot().parseTitle(pageTitle, {
        prop: "text",
        redirects: true,
        disableeditsection: true,
        disabletoc: true,
        disablelimitreport: true,
      });
    } catch (error) {
      if (isMissingPageError(error)) {
        logger.debug(`[wikiBot] 页面「${pageTitle}」不存在，跳过`);
        return null;
      }
      logger.debug(
        `[wikiBot] 获取「${pageTitle}」渲染 HTML 失败：${getErrorMessage(error)}`,
      );
      return null;
    }

    const text = extractPlainText(html, {
      tableMode: "flatten",
      maxLength: options.limit ?? WikiBotService.PAGE_TEXT_LIMIT,
    });
    if (!text) {
      logger.debug(`[wikiBot] 「${pageTitle}」抽出的正文为空`);
      return null;
    }

    this.cachePageText(key, text);
    logger.debug(
      `[wikiBot] 「${pageTitle}」正文 ${text.length} 字（HTML ${html.length} 字）`,
    );
    return text;
  }

  /** wiki 全文检索 → 页面标题；救「高压制氧」这类不是页面名的叫法 */
  async searchPageTitles(keyword: string, limit = 1): Promise<string[]> {
    const term = keyword.trim();
    if (!term || !this.isBWikiBotReady()) return [];

    try {
      const results = await this.getBWikiBot().search(term, Math.max(1, limit));
      return (results ?? [])
        .map((item) => item?.title)
        .filter((title): title is string => Boolean(title));
    } catch (error) {
      logger.debug(
        `[wikiBot] 检索「${term}」失败：${getErrorMessage(error)}`,
      );
      return [];
    }
  }

  private cachePageText(key: string, text: string): void {
    // 先删再插：让 Map 的插入顺序等于「最近一次写入」，FIFO 淘汰才不会误伤热页
    this.pageTextCache.delete(key);
    if (this.pageTextCache.size >= WikiBotService.PAGE_TEXT_CACHE_SIZE) {
      const oldest = this.pageTextCache.keys().next().value;
      if (oldest !== undefined) this.pageTextCache.delete(oldest);
    }
    this.pageTextCache.set(key, { text, at: Date.now() });
  }

  private getBot(site: WikiSite): Mwn {
    if (!this.botOf(site)) {
      throw new Error(
        `${WikiBotService.siteLabel(site)} bot 尚未就绪，请检查登录配置或查看日志`,
      );
    }
    let proxy = this.botProxies[site];
    if (!proxy) {
      proxy = this.createBotProxy(site);
      this.botProxies[site] = proxy;
    }
    return proxy;
  }
}

/** 账号配置来自共享分组，键名与默认值见 src/config.ts */
export type WikiBotServiceConfig = AccountConfig;

/** 页面不存在时的 MediaWiki 错误码（`action=parse` 对缺失页面返回 missingtitle） */
const MISSING_PAGE_CODES = new Set([
  "missingtitle",
  "invalidtitle",
  "nosuchpageid",
  "missingcontent",
]);

function isMissingPageError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && MISSING_PAGE_CODES.has(code);
}
