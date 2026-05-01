import { Context, Logger, Schema } from "koishi";
import {} from "koishi-plugin-cron";
import { incrementalUpdate, syncPages, syncSinglePage } from "../sync/pageSync";
import { syncModules, syncSingleModule } from "../sync/moduleSync";
import { syncAllImages, syncSingleImage } from "../sync/imgSync";
import { logger } from "../utils/tools";

export interface SyncCommandsConfig {
  logsUrl: string;
  ggUsername: string;
  ggPassword: string;
  bwikiusername: string;
  bwikipassword: string;
  domain: string;
  main_site: string;
  bwiki_site: string;
}

export class SyncCommands {
  public static readonly inject = ["wikiBot", "cron"];
  public config: SyncCommandsConfig;

  constructor(ctx: Context, config: SyncCommandsConfig) {
    this.config = config;
    logger.info("WikiBot 服务已就绪，初始化定时任务和指令");

    ctx.cron("15 * * * *", async () => {
      if (!(await this.ensureBotsReady(ctx, "增量更新"))) return;

      await incrementalUpdate(
        ctx.wikiBot.getGGBot(),
        ctx.wikiBot.getBWikiBot(),
        config,
      );
    });

    ctx.cron("30 8 * * 4", async () => {
      if (!(await this.ensureBotsReady(ctx, "同步所有页面"))) return;

      await syncPages(ctx.wikiBot.getGGBot(), ctx.wikiBot.getBWikiBot())
        .then(() => {
          logger.info("自动任务：尝试同步所有页面，从 WIKIGG 到 bwiki");
        })
        .catch((err) => {
          logger.error(`同步所有页面失败，错误信息：${err}`);
        });
    });

    ctx.cron("30 8 * * 3", async () => {
      if (!(await this.ensureBotsReady(ctx, "同步所有图片"))) return;

      await syncAllImages(
        ctx.wikiBot.getGGBot(),
        ctx.wikiBot.getBWikiBot(),
        config,
      )
        .then(() => {
          logger.info("自动任务：尝试同步所有图片，从 WIKIGG 到 bwiki");
        })
        .catch((err) => {
          logger.error(`同步所有图片失败，错误信息：${err}`);
        });
    });

    this.registerCommands(ctx);
  }

  /**
   * 确保机器人就绪，如果未就绪则尝试重新登录
   * @param ctx Koishi 上下文
   * @param taskName 任务名称（用于日志）
   * @returns 机器人是否已就绪
   */
  private async ensureBotsReady(
    ctx: Context,
    taskName: string,
  ): Promise<boolean> {
    // 检查并尝试重新登录失效的机器人
    if (!ctx.wikiBot.isGGBotReady() || !ctx.wikiBot.isBWikiBotReady()) {
      logger.warn(`检测到部分机器人未就绪，尝试重新登录...`);
      try {
        await ctx.wikiBot.relogin();
      } catch (error) {
        logger.error(`重新登录失败: ${error}`);
        return false;
      }
    }

    // 最终检查机器人是否真正就绪
    const ggReady = ctx.wikiBot.isGGBotReady();
    const bwikiReady = ctx.wikiBot.isBWikiBotReady();

    if (!ggReady || !bwikiReady) {
      logger.warn(
        `${taskName} 跳过：Wiki 机器人仍未就绪 - WIKIGG: ${ggReady ? "✅" : "❌"}, bwiki: ${bwikiReady ? "✅" : "❌"}`,
      );
      return false;
    }

    return true;
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("sync <pageTitle:string>", "同步指定页面", { authority: 2 })
      .action(async ({ session }, pageTitle) => {
        if (!(await this.ensureBotsReady(ctx, "同步页面"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await syncSinglePage(
            ctx.wikiBot.getGGBot(),
            ctx.wikiBot.getBWikiBot(),
            pageTitle,
            "sync-bot",
          );
          return `✅ 已尝试同步页面：${pageTitle}，请前往控制台查看：${this.config.logsUrl}`;
        } catch (err) {
          logger.error(`同步页面 ${pageTitle} 失败，错误信息：${err}`);
          return `❌ 同步页面失败：${pageTitle}`;
        }
      });

    ctx
      .command("sync.incrementalUpdate", "获取3h内的编辑并尝试更新", {
        authority: 2,
      })
      .alias("增量更新")
      .action(async ({ session }) => {
        if (!(await this.ensureBotsReady(ctx, "增量更新"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await incrementalUpdate(
            ctx.wikiBot.getGGBot(),
            ctx.wikiBot.getBWikiBot(),
            this.config,
          );
          return `✅ 已尝试获取三小时前的编辑并同步，请前往控制台查看：${this.config.logsUrl}`;
        } catch (err) {
          logger.error(`增量更新失败，错误信息：${err}`);
          return `❌ 增量更新失败，请前往控制台查看日志：${this.config.logsUrl}`;
        }
      });

    ctx
      .command("sync.allpages", "同步所有页面", { authority: 2 })
      .action(async ({ session }) => {
        if (!(await this.ensureBotsReady(ctx, "同步所有页面"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await syncPages(ctx.wikiBot.getGGBot(), ctx.wikiBot.getBWikiBot());
          return `✅ 已尝试同步所有页面，请前往控制台查看：${this.config.logsUrl}`;
        } catch (err) {
          logger.error(`同步所有页面失败，错误信息：${err}`);
          return `❌ 同步所有页面失败，请前往控制台查看日志:${this.config.logsUrl}`;
        }
      });

    ctx
      .command("sync.module <moduleTitle:string>", "同步指定模块", {
        authority: 2,
      })
      .action(async ({ session }, moduleTitle) => {
        if (!(await this.ensureBotsReady(ctx, "同步模块"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await syncSingleModule(
            ctx.wikiBot.getGGBot(),
            ctx.wikiBot.getBWikiBot(),
            moduleTitle,
            "sync-bot",
          );
          return `✅ 已尝试同步模块：${moduleTitle}，请前往控制台查看：${this.config.logsUrl}`;
        } catch (err) {
          logger.error(`同步模块 ${moduleTitle} 失败，错误信息：${err}`);
          return `❌ 同步模块失败：${moduleTitle}`;
        }
      });

    ctx
      .command("sync.allmodules", "同步所有模块", { authority: 2 })
      .action(async ({ session }) => {
        if (!(await this.ensureBotsReady(ctx, "同步所有模块"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await syncModules(ctx.wikiBot.getGGBot(), ctx.wikiBot.getBWikiBot());
          return `✅ 已尝试同步所有模块，请前往控制台查看：${this.config.logsUrl}`;
        } catch (err) {
          logger.error(`同步所有模块失败，错误信息：${err}`);
          return `❌ 同步所有模块失败，请前往控制台查看日志:${this.config.logsUrl}`;
        }
      });

    ctx
      .command("sync.img <imgTitle:string>", "同步指定图片", { authority: 2 })
      .action(async ({ session }, imgTitle) => {
        if (!(await this.ensureBotsReady(ctx, "同步图片"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await syncSingleImage(
            ctx.wikiBot.getGGBot(),
            ctx.wikiBot.getBWikiBot(),
            `${imgTitle.startsWith("File:") ? "" : "File:"}${imgTitle}`,
            this.config,
          );
          return `✅ 已尝试同步图片：${imgTitle}`;
        } catch (err) {
          logger.error(`同步图片 ${imgTitle} 失败，错误信息：${err}`);
          return `❌ 同步图片失败：${imgTitle}`;
        }
      });

    ctx
      .command("sync.allimgs", "同步所有图片", { authority: 2 })
      .action(async ({ session }) => {
        if (!(await this.ensureBotsReady(ctx, "同步所有图片"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await syncAllImages(
            ctx.wikiBot.getGGBot(),
            ctx.wikiBot.getBWikiBot(),
            this.config,
          );
          return `✅ 已尝试同步所有图片，请前往控制台查看：${this.config.logsUrl}`;
        } catch (err) {
          logger.error(`同步所有图片失败，错误信息：${err}`);
          return `❌ 同步所有图片失败，请前往控制台查看日志:${this.config.logsUrl}`;
        }
      });
  }
}

export namespace SyncCommands {
  export const Config: Schema<SyncCommandsConfig> = Schema.object({
    ggUsername: Schema.string().description("WIKIGG 用户名").default("1"),
    ggPassword: Schema.string().description("WIKIGG 密码").default("1"),
    bwikiusername: Schema.string().description("bwiki用户名").default("1"),
    bwikipassword: Schema.string().description("bwiki密码").default("1"),
    domain: Schema.string()
      .description("你的短链域名（必填，如：klei.vip）")
      .default("klei.vip"),
    main_site: Schema.string()
      .description("主站域名（必填，如：oxygennotincluded.wiki.gg）")
      .default("oxygennotincluded.wiki.gg/zh"),
    bwiki_site: Schema.string()
      .description("镜像站域名（必填，如：wiki.biligame.com）")
      .default("wiki.biligame.com/oni"),
    logsUrl: Schema.string()
      .description("日志查看地址")
      .default("https://klei.vip/onilogs"),
  });
}

export function apply(ctx: Context, config: SyncCommandsConfig) {
  ctx.inject(["wikiBot"], (ctx) => {
    ctx.plugin(SyncCommands, config);
  });
}
