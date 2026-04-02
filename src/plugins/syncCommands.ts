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
  public log: Logger;

  constructor(ctx: Context, config: SyncCommandsConfig) {
    this.config = config;
    this.log = ctx.logger("oni-sync");
    logger.info("WikiBot 服务已就绪，初始化定时任务和指令");

    ctx.cron("15 * * * *", async () => {
      await incrementalUpdate(
        ctx.wikiBot.getGGBot(),
        ctx.wikiBot.getBWikiBot(),
        config,
      );
    });

    ctx.cron("30 8 * * 4", async () => {
      await syncPages(ctx.wikiBot.getGGBot(), ctx.wikiBot.getBWikiBot())
        .then(() => {
          logger.info("自动任务：尝试同步所有页面，从 WIKIGG 到 bwiki");
        })
        .catch((err) => {
          logger.error(`同步所有页面失败`);
          this.log.error(`，错误信息：${err}`);
        });
    });

    ctx.cron("30 8 * * 3", async () => {
      await syncAllImages(
        ctx.wikiBot.getGGBot(),
        ctx.wikiBot.getBWikiBot(),
        config,
      )
        .then(() => {
          logger.info("自动任务：尝试同步所有图片，从 WIKIGG 到 bwiki");
        })
        .catch((err) => {
          logger.error(`同步所有图片失败`);
          this.log.error(`，错误信息：${err}`);
        });
    });

    this.registerCommands(ctx);
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("sync <pageTitle:string>", "同步指定页面", { authority: 2 })
      .action(async ({ session }, pageTitle) => {
        await syncSinglePage(
          ctx.wikiBot.getGGBot(),
          ctx.wikiBot.getBWikiBot(),
          pageTitle,
          "sync-bot",
        )
          .then(() => {
            session.send(
              `✅ 已尝试同步页面：${pageTitle}，请前往控制台查看：${this.config.logsUrl}`,
            );
          })
          .catch((err) => {
            session.send(`❌ 同步页面失败：${pageTitle}`);
            this.log.error(`，错误信息：${err}`);
          });
      });

    ctx
      .command("sync.incrementalUpdate", "获取3h内的编辑并尝试更新", {
        authority: 2,
      })
      .alias("增量更新")
      .action(async ({ session }) => {
        session.send(
          `🚀 获取3h内的编辑并尝试更新，任务耗时可能较长，请前往控制台查看日志:${this.config.logsUrl}`,
        );
        await incrementalUpdate(
          ctx.wikiBot.getGGBot(),
          ctx.wikiBot.getBWikiBot(),
          this.config,
        )
          .then(() => {
            session.send(
              `✅ 已尝试获取三小时前的编辑并同步，请前往控制台查看：${this.config.logsUrl}`,
            );
          })
          .catch((err) => {
            session.send(
              `❌ 同步所有页面失败，请前往控制台查看日志:${this.config.logsUrl}`,
            );
            this.log.error(`同步所有页面失败，错误信息：${err}`);
          });
      });

    ctx
      .command("sync.allpages", "同步所有页面", { authority: 2 })
      .action(async ({ session }) => {
        session.send(
          `🚀 开始同步所有页面，任务耗时较长，请前往控制台查看日志:${this.config.logsUrl}`,
        );
        await syncPages(ctx.wikiBot.getGGBot(), ctx.wikiBot.getBWikiBot())
          .then(() => {
            session.send(
              `✅ 已尝试同步所有页面，请前往控制台查看：${this.config.logsUrl}`,
            );
          })
          .catch((err) => {
            session.send(
              `❌ 同步所有页面失败，请前往控制台查看日志:${this.config.logsUrl}`,
            );
            this.log.error(`同步所有页面失败，错误信息：${err}`);
          });
      });

    ctx
      .command("sync.module <moduleTitle:string>", "同步指定模块", {
        authority: 2,
      })
      .action(async ({ session }, moduleTitle) => {
        await session.send(
          `✅ 同步中，请前往控制台查看：${this.config.logsUrl}`,
        );
        await syncSingleModule(
          ctx.wikiBot.getGGBot(),
          ctx.wikiBot.getBWikiBot(),
          moduleTitle,
          "sync-bot",
        )
          .then(() => {
            session.send(
              `✅ 已尝试同步模块：${moduleTitle}，请前往控制台查看：${this.config.logsUrl}`,
            );
          })
          .catch((err) => {
            session.send(`❌ 同步模块失败：${moduleTitle}`);
            this.log.error(`错误信息：${err}`);
          });
      });

    ctx
      .command("sync.allmodules", "同步所有模块", { authority: 2 })
      .action(async ({ session }) => {
        await session.send(
          `🚀 开始同步所有模块，任务耗时较长，请前往控制台查看：${this.config.logsUrl}`,
        );
        await syncModules(ctx.wikiBot.getGGBot(), ctx.wikiBot.getBWikiBot())
          .then(() => {
            session.send(
              `✅ 已尝试同步所有模块，请前往控制台查看：${this.config.logsUrl}`,
            );
          })
          .catch((err) => {
            session.send(
              `❌ 同步所有模块失败，请前往控制台查看日志:${this.config.logsUrl}`,
            );
            this.log.error(`同步所有模块失败，错误信息：${err}`);
          });
      });

    ctx
      .command("sync.img <imgTitle:string>", "同步指定图片", { authority: 2 })
      .action(async ({ session }, imgTitle) => {
        await session.send(
          `🚀 开始同步，任务可能耗时较长，请前往控制台查看：${this.config.logsUrl}`,
        );
        await syncSingleImage(
          ctx.wikiBot.getGGBot(),
          ctx.wikiBot.getBWikiBot(),
          `${imgTitle.startsWith("File:") ? "" : "File:"}${imgTitle}`,
          this.config,
        )
          .then(() => {
            session.send(`✅ 已尝试同步图片：${imgTitle}`);
          })
          .catch((err) => {
            session.send(`❌ 同步图片失败：${imgTitle}`);
            this.log.error(`同步图片失败：${imgTitle}，错误信息：${err}`);
          });
      });

    ctx
      .command("sync.allimgs", "同步所有图片", { authority: 2 })
      .action(async ({ session }) => {
        session.send(
          `🚀 开始同步所有图片，任务耗时较长，请前往控制台查看：${this.config.logsUrl}`,
        );
        await syncAllImages(
          ctx.wikiBot.getGGBot(),
          ctx.wikiBot.getBWikiBot(),
          this.config,
        )
          .then(() => {
            session.send(
              `✅ 已尝试同步所有图片，请前往控制台查看：${this.config.logsUrl}`,
            );
          })
          .catch((err) => {
            session.send(
              `❌ 同步所有图片失败，请前往控制台查看日志:${this.config.logsUrl}`,
            );
            this.log.error(`同步所有图片失败，错误信息：${err}`);
          });
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
