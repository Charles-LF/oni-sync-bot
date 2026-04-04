import { Context, Service, Schema } from "koishi";
import { Mwn } from "mwn";
import { logger, getErrorMessage } from "../utils/tools";

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

export class WikiBotService extends Service {
  public static readonly inject = [];

  public ggbot: Mwn | null = null;
  public bwikibot: Mwn | null = null;
  public isReady = false;
  private botConfig: WikiBotServiceConfig;
  private static readonly USER_AGENT = `OniSyncBot/1.0 (https://klei.vip; Charles@klei.vip)`;
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY = 5000;

  constructor(ctx: Context, config: WikiBotServiceConfig) {
    super(ctx, "wikiBot", true);
    this.botConfig = config;
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async loginWithRetry(
    siteConfig: ISiteConfig,
    attempt = 1,
  ): Promise<Mwn> {
    try {
      logger.info(
        `正在登录 ${siteConfig.name}... (尝试 ${attempt}/${WikiBotService.MAX_RETRIES})`,
      );
      const bot = await this.login(siteConfig);
      return bot;
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      if (attempt < WikiBotService.MAX_RETRIES) {
        logger.warn(
          `登录 ${siteConfig.name} 失败，${WikiBotService.RETRY_DELAY / 1000}秒后重试...`,
          errorMsg,
        );
        await this.delay(WikiBotService.RETRY_DELAY);
        return this.loginWithRetry(siteConfig, attempt + 1);
      }
      logger.error(
        `登录 ${siteConfig.name} 失败，已达到最大重试次数`,
        errorMsg,
      );
      throw error;
    }
  }

  private async login(siteConfig: ISiteConfig): Promise<Mwn> {
    logger.info(`正在连接 ${siteConfig.name} API: ${siteConfig.api}`);

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
          logger.warn("Cookie 注入失败:", err);
        } else {
          logger.info("Cookie 注入成功");
        }
      });
      bot.setRequestOptions({
        headers: {
          referer: "https://wiki.biligame.com/oni/",
          "User-Agent": siteConfig.userAgent,
        },
      });
    }

    logger.info(`正在执行 ${siteConfig.name} 登录...`);
    await bot.login();

    logger.info(`✅ 成功登录 ${siteConfig.name}`);
    return bot;
  }

  async start() {
    logger.info("WikiBotService 正在初始化...");
    try {
      const sitesConfig = this.getSitesConfig();

      logger.info("开始登录 WIKIGG...");
      try {
        this.ggbot = await this.loginWithRetry(sitesConfig.gg);
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        logger.error(
          "WIKIGG 登录失败，服务将继续运行，但 WIKIGG 相关功能不可用",
          errorMsg,
        );
      }

      logger.info("开始登录 bwiki...");
      try {
        this.bwikibot = await this.loginWithRetry(sitesConfig.bwiki);
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        logger.error(
          "bwiki 登录失败，服务将继续运行，但 bwiki 相关功能不可用",
          errorMsg,
        );
      }

      if (this.ggbot && this.bwikibot) {
        this.isReady = true;
        logger.info("WikiBotService 初始化成功，两个 Wiki 已登录");
      } else if (this.ggbot || this.bwikibot) {
        this.isReady = true;
        logger.warn(
          `WikiBotService 部分初始化成功，已登录: ${this.ggbot ? "WIKIGG" : ""} ${this.bwikibot ? "bwiki" : ""}`,
        );
      } else {
        logger.error("WikiBotService 初始化失败，所有登录都失败");
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      logger.error("WikiBotService 初始化出错:", errorMsg);
    }
  }

  stop() {
    this.isReady = false;
    this.ggbot = null;
    this.bwikibot = null;
    logger.info("WikiBotService 已停止");
  }

  async relogin(): Promise<{ gg: boolean; bwiki: boolean }> {
    const sitesConfig = this.getSitesConfig();
    let ggSuccess = false;
    let bwikiSuccess = false;

    logger.info("开始重新登录 WIKIGG...");
    try {
      this.ggbot = await this.loginWithRetry(sitesConfig.gg);
      ggSuccess = true;
      logger.info("✅ 成功重新登录 WIKIGG");
    } catch (error) {
      this.ggbot = null;
      const errorMsg = getErrorMessage(error);
      logger.error("❌ 重新登录 WIKIGG 失败", errorMsg);
    }

    logger.info("开始重新登录 bwiki...");
    try {
      this.bwikibot = await this.loginWithRetry(sitesConfig.bwiki);
      bwikiSuccess = true;
      logger.info("✅ 成功重新登录 bwiki");
    } catch (error) {
      this.bwikibot = null;
      const errorMsg = getErrorMessage(error);
      logger.error("❌ 重新登录 bwiki 失败", errorMsg);
    }

    if (this.ggbot && this.bwikibot) {
      this.isReady = true;
      logger.info("WikiBotService 重新登录成功，两个 Wiki 已登录");
    } else if (this.ggbot || this.bwikibot) {
      this.isReady = true;
      logger.warn(
        `WikiBotService 部分重新登录成功，已登录: ${this.ggbot ? "WIKIGG" : ""} ${this.bwikibot ? "bwiki" : ""}`,
      );
    } else {
      this.isReady = false;
      logger.error("WikiBotService 重新登录失败，所有登录都失败");
    }

    return { gg: ggSuccess, bwiki: bwikiSuccess };
  }

  private async reloginSite(site: "gg" | "bwiki"): Promise<void> {
    const sitesConfig = this.getSitesConfig();
    const siteConfig = site === "gg" ? sitesConfig.gg : sitesConfig.bwiki;

    try {
      const bot = await this.loginWithRetry(siteConfig);
      if (site === "gg") {
        this.ggbot = bot;
      } else {
        this.bwikibot = bot;
      }
      logger.info(`✅ ${siteConfig.name} 自动重新登录成功`);
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      if (site === "gg") {
        this.ggbot = null;
      } else {
        this.bwikibot = null;
      }
      logger.error(`❌ ${siteConfig.name} 自动重新登录失败`, errorMsg);
      throw error;
    }
  }

  isGGBotReady(): boolean {
    return this.ggbot !== null;
  }

  isBWikiBotReady(): boolean {
    return this.bwikibot !== null;
  }

  private createBotProxy(bot: Mwn, site: "gg" | "bwiki"): Mwn {
    const self = this;
    return new Proxy(bot, {
      get(target: any, prop) {
        const originalMethod = target[prop];
        if (typeof originalMethod !== "function") {
          return originalMethod;
        }

        return async function (...args: any[]) {
          try {
            return await originalMethod.apply(target, args);
          } catch (error: any) {
            if (error.code === "assertuserfailed") {
              logger.warn(
                `检测到 ${site === "gg" ? "WIKIGG" : "bwiki"} 登录过期，正在自动重新登录...`,
              );
              await self.reloginSite(site);
              const newBot = site === "gg" ? self.ggbot : self.bwikibot;
              if (!newBot) {
                throw new Error(
                  `${site === "gg" ? "WIKIGG" : "bwiki"} 自动重新登录失败`,
                );
              }
              return await newBot[prop].apply(newBot, args);
            }
            throw error;
          }
        };
      },
    });
  }

  getGGBot(): Mwn {
    if (!this.ggbot) {
      throw new Error("WIKIGG bot 尚未就绪，请检查登录配置或查看日志");
    }
    return this.createBotProxy(this.ggbot, "gg");
  }

  getBWikiBot(): Mwn {
    if (!this.bwikibot) {
      throw new Error("bwiki bot 尚未就绪，请检查登录配置或查看日志");
    }
    return this.createBotProxy(this.bwikibot, "bwiki");
  }
}

export interface WikiBotServiceConfig {
  ggUsername: string;
  ggPassword: string;
  bwikiusername: string;
  bwikipassword: string;
}

export namespace WikiBotService {
  export const Config: Schema<WikiBotServiceConfig> = Schema.object({
    ggUsername: Schema.string().description("WIKIGG 用户名").default("1"),
    ggPassword: Schema.string().description("WIKIGG 密码").default("1"),
    bwikiusername: Schema.string().description("bwiki用户名").default("1"),
    bwikipassword: Schema.string().description("bwiki密码").default("1"),
  });
}

export function apply(ctx: Context, config: WikiBotServiceConfig) {
  ctx.plugin(WikiBotService, config);
}
