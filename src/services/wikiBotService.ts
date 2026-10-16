import { Context, Service } from "koishi";
import type { AccountConfig } from "../config";
import { Mwn } from "mwn";
import { logger, getErrorMessage } from "../utils/tools";
import { withRetry } from "../utils/async";

/** MediaWiki 登录态失效（`assert=user` 失败）时返回的错误码 */
function isAssertUserFailed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "assertuserfailed"
  );
}

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

  /**
   * 生成一个"登录态永远有效"的客户端代理。
   *
   * 设计说明（为什么必须是代理而不是普通对象）：
   * Mwn 的方法很多，且调用方需要 `continuedQueryGen` 这类**异步生成器**以及
   * `options` 这类**非函数属性**。用代理可以完整转发任意成员，同时把
   * "assert=user 失败 → 重新登录 → 重放调用" 这件事对调用方完全隐藏。
   */
  private createBotProxy(site: WikiSite): Mwn {
    const label = WikiBotService.siteLabel(site);
    const METHODS_TO_SKIP = new Set(["cookieJar", "setRequestOptions"]);

    const getCurrentBot = (): Mwn => {
      const bot = this.botOf(site);
      if (!bot) {
        throw new Error(`${label} bot 尚未就绪，请检查登录配置或查看日志`);
      }
      return bot;
    };

    const memberOf = (bot: Mwn, prop: string | symbol): unknown =>
      (bot as unknown as Record<string | symbol, unknown>)[prop];

    /** 登录态失效时自动重登并重放一次调用 */
    const invokeWithRelogin = async <T>(
      invoke: (bot: Mwn) => Promise<T>,
    ): Promise<T> => {
      try {
        return await invoke(getCurrentBot());
      } catch (error) {
        if (!isAssertUserFailed(error)) throw error;
        await this.reloginSite(site);
        return await invoke(getCurrentBot());
      }
    };

    return new Proxy({} as Mwn, {
      get: (_target, prop) => {
        const value = memberOf(getCurrentBot(), prop);

        // 非函数成员（如 options）直接透传
        if (typeof value !== "function") return value;

        // 这两个是登录相关的内部方法，必须绑定到当前 bot 本身
        if (typeof prop === "string" && METHODS_TO_SKIP.has(prop)) {
          return value.bind(this.botOf(site));
        }

        // 异步生成器要单独处理：重试必须发生在**迭代过程中**，
        // 而不是创建生成器的那一刻。
        if (prop === "continuedQueryGen") {
          return (...args: unknown[]) => {
            // 注意：下面 next() 是用方法简写定义的，其中的 this 指向返回的迭代器对象，
            // 因此必须在这里先把重新登录的动作捕获成普通函数。
            const relogin = () => this.reloginSite(site);

            const createIterator = (callArgs: unknown[]) => {
              const generate = memberOf(
                getCurrentBot(),
                "continuedQueryGen",
              ) as unknown as (...a: unknown[]) => AsyncGenerator<unknown>;
              return generate(...callArgs)[Symbol.asyncIterator]();
            };

            let iterator = createIterator(args);

            return {
              [Symbol.asyncIterator]() {
                return this;
              },
              async next(): Promise<IteratorResult<unknown>> {
                try {
                  return await iterator.next();
                } catch (error) {
                  if (!isAssertUserFailed(error)) throw error;
                  await relogin();
                  iterator = createIterator(args);
                  return await iterator.next();
                }
              },
            };
          };
        }

        return (...args: unknown[]) =>
          invokeWithRelogin((bot) => {
            const method = memberOf(bot, prop);
            if (typeof method !== "function") {
              throw new Error(`${label} bot 缺少方法 ${String(prop)}`);
            }
            const call = method as unknown as (
              ...a: unknown[]
            ) => Promise<unknown>;
            return call.apply(bot, args);
          });
      },
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
