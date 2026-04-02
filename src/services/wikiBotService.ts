import { Context, Service, Schema } from "koishi";
import { Mwn } from "mwn";
import { logger } from "../utils/tools";

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
      if (attempt < WikiBotService.MAX_RETRIES) {
        logger.warn(
          `登录 ${siteConfig.name} 失败，${WikiBotService.RETRY_DELAY / 1000}秒后重试...`,
          error,
        );
        await this.delay(WikiBotService.RETRY_DELAY);
        return this.loginWithRetry(siteConfig, attempt + 1);
      }
      logger.error(`登录 ${siteConfig.name} 失败，已达到最大重试次数`, error);
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
      this.ggbot = await this.loginWithRetry(sitesConfig.gg);

      logger.info("开始登录 bwiki...");
      this.bwikibot = await this.loginWithRetry(sitesConfig.bwiki);

      if (this.ggbot && this.bwikibot) {
        this.isReady = true;
        logger.info("WikiBotService 初始化成功，两个 Wiki 已登录");
      } else {
        logger.error("WikiBotService 初始化失败，部分登录失败");
      }
    } catch (error) {
      logger.error("WikiBotService 初始化出错:", error);
      throw error;
    }
  }

  stop() {
    this.isReady = false;
    this.ggbot = null;
    this.bwikibot = null;
    logger.info("WikiBotService 已停止");
  }

  getGGBot(): Mwn {
    if (!this.ggbot || !this.isReady) {
      throw new Error("WikiGG bot 尚未就绪");
    }
    return this.ggbot;
  }

  getBWikiBot(): Mwn {
    if (!this.bwikibot || !this.isReady) {
      throw new Error("bwiki bot 尚未就绪");
    }
    return this.bwikibot;
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
    ggUsername: Schema.string().default("1"),
    ggPassword: Schema.string().default("1"),
    bwikiusername: Schema.string().default("1"),
    bwikipassword: Schema.string().default("1"),
  });
}

export function apply(ctx: Context, config: WikiBotServiceConfig) {
  ctx.plugin(WikiBotService, config);
}
