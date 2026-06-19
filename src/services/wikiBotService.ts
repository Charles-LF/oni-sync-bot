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
      const bot = await this.login(siteConfig);
      return bot;
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      if (attempt < WikiBotService.MAX_RETRIES) {
        await this.delay(WikiBotService.RETRY_DELAY);
        return this.loginWithRetry(siteConfig, attempt + 1);
      }
      logger.error(`❌ ${siteConfig.name} 登录失败`, errorMsg);
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
      const sitesConfig = this.getSitesConfig();

      try {
        this.ggbot = await this.loginWithRetry(sitesConfig.gg);
        logger.info("✅ WIKIGG 登录成功");
      } catch (error) {
        this.ggbot = null;
      }

      try {
        this.bwikibot = await this.loginWithRetry(sitesConfig.bwiki);
        logger.info("✅ bwiki 登录成功");
      } catch (error) {
        this.bwikibot = null;
      }

      this.isReady = this.ggbot !== null || this.bwikibot !== null;
      if (!this.isReady) {
        logger.error("❌ WikiBotService 初始化失败，两个 Wiki 均无法登录");
      }
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      logger.error("❌ WikiBotService 初始化异常:", errorMsg);
    }
  }

  stop() {
    this.isReady = false;
    this.ggbot = null;
    this.bwikibot = null;
    this.ggbotProxy = null;
    this.bwikibotProxy = null;
  }

  async relogin(): Promise<{ gg: boolean; bwiki: boolean }> {
    const sitesConfig = this.getSitesConfig();
    let ggSuccess = false;
    let bwikiSuccess = false;

    try {
      this.ggbot = await this.loginWithRetry(sitesConfig.gg);
      ggSuccess = true;
      logger.info("✅ WIKIGG 重新登录成功");
    } catch (error) {
      this.ggbot = null;
    }

    try {
      this.bwikibot = await this.loginWithRetry(sitesConfig.bwiki);
      bwikiSuccess = true;
      logger.info("✅ bwiki 重新登录成功");
    } catch (error) {
      this.bwikibot = null;
    }

    this.isReady = this.ggbot !== null || this.bwikibot !== null;
    return { gg: ggSuccess, bwiki: bwikiSuccess };
  }

  private async reloginSite(site: "gg" | "bwiki"): Promise<void> {
    const siteName = site === "gg" ? "WIKIGG" : "bwiki";
    const sitesConfig = this.getSitesConfig();
    const siteConfig = site === "gg" ? sitesConfig.gg : sitesConfig.bwiki;

    try {
      const bot = await this.loginWithRetry(siteConfig);
      if (site === "gg") {
        this.ggbot = bot;
      } else {
        this.bwikibot = bot;
      }
      logger.info(`✅ ${siteName} 自动重新登录成功`);
    } catch (error) {
      if (site === "gg") {
        this.ggbot = null;
      } else {
        this.bwikibot = null;
      }
      throw error;
    }
  }

  isGGBotReady(): boolean {
    return this.ggbot !== null;
  }

  isBWikiBotReady(): boolean {
    return this.bwikibot !== null;
  }

  private createBotProxy(site: "gg" | "bwiki"): Mwn {
    const self = this;

    const METHODS_TO_SKIP = new Set(["cookieJar", "setRequestOptions"]);

    const getCurrentBot = (): Mwn => {
      const bot = site === "gg" ? self.ggbot : self.bwikibot;
      if (!bot) {
        throw new Error(
          `${site === "gg" ? "WIKIGG" : "bwiki"} bot 尚未就绪，请检查登录配置或查看日志`,
        );
      }
      return bot;
    };

    return new Proxy({} as Mwn, {
      get(_target: any, prop) {
        const propKey = prop as keyof Mwn;
        const currentBot = getCurrentBot();
        const value = currentBot[propKey];
        if (typeof value !== "function") {
          return value;
        }

        if (METHODS_TO_SKIP.has(prop as string)) {
          return value.bind(currentBot);
        }

        if (prop === "continuedQueryGen") {
          return function (...args: any[]) {
            let activeBot = getCurrentBot();
            let activeMethod = activeBot.continuedQueryGen;
            let activeIterator = activeMethod
              .apply(activeBot, args)
              [Symbol.asyncIterator]();

            return {
              [Symbol.asyncIterator]() {
                return this;
              },
              async next() {
                try {
                  return await activeIterator.next();
                } catch (error: any) {
                  if (error.code === "assertuserfailed") {
                    await self.reloginSite(site);
                    activeBot = getCurrentBot();
                    activeMethod = activeBot.continuedQueryGen;
                    const newGen = activeMethod.apply(activeBot, args);
                    activeIterator = newGen[Symbol.asyncIterator]();
                    return await activeIterator.next();
                  }
                  throw error;
                }
              },
            };
          };
        }

        return async function (...args: any[]) {
          let executeBot = getCurrentBot();
          let method = executeBot[propKey];
          if (typeof method !== "function") {
            throw new Error(
              `${site === "gg" ? "WIKIGG" : "bwiki"} bot 缺少方法 ${String(prop)}`,
            );
          }
          try {
            return await (method as any).apply(executeBot, args);
          } catch (error: any) {
            if (error.code === "assertuserfailed") {
              await self.reloginSite(site);
              executeBot = getCurrentBot();
              method = executeBot[propKey];
              if (typeof method !== "function") {
                throw new Error(
                  `${site === "gg" ? "WIKIGG" : "bwiki"} 新 bot 缺少方法 ${String(prop)}`,
                );
              }
              return await (method as any).apply(executeBot, args);
            }
            throw error;
          }
        };
      },
    });
  }

  private ggbotProxy: Mwn | null = null;
  private bwikibotProxy: Mwn | null = null;

  getGGBot(): Mwn {
    if (!this.ggbot) {
      throw new Error("WIKIGG bot 尚未就绪，请检查登录配置或查看日志");
    }
    if (!this.ggbotProxy) {
      this.ggbotProxy = this.createBotProxy("gg");
    }
    return this.ggbotProxy;
  }

  getBWikiBot(): Mwn {
    if (!this.bwikibot) {
      throw new Error("bwiki bot 尚未就绪，请检查登录配置或查看日志");
    }
    if (!this.bwikibotProxy) {
      this.bwikibotProxy = this.createBotProxy("bwiki");
    }
    return this.bwikibotProxy;
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
