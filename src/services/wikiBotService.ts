import { Context, Service } from "koishi";
import type { AccountConfig } from "../config";
import { Mwn } from "mwn";
import { logger, getErrorMessage } from "../utils/tools";
import { withRetry } from "../utils/async";
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
