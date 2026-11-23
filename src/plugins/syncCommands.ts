import { Context } from "koishi";
import type { NotifyConfig } from "../config";
import { sleep } from "../utils/async";
import { Mwn } from "mwn";
import { PageSyncer } from "../sync/pageSync";
import { ModuleSyncer } from "../sync/moduleSync";
import { ImageSyncer } from "../sync/imgSync";
import { logger, formatWikiTime } from "../utils/tools";

/**
 * 实际只消费日志地址与通知字段；
 * 账号配置由 WikiBotService 使用，因此这里不再重复声明（详见 src/config.ts）。
 */
export type SyncCommandsConfig = NotifyConfig;

export class SyncCommands {
  /** `http` 可选：缺它只影响内置模组的网络请求 */
  public static readonly inject = {
    wikiBot: { required: true },
    database: { required: true },
    oniCron: { required: true },
    syncConsole: { required: true },
    http: { required: false },
  };
  public config: SyncCommandsConfig;

  constructor(ctx: Context, config: SyncCommandsConfig) {
    this.config = config;
    logger.info("WikiBot 服务已就绪，初始化定时任务和指令");

    this.registerScheduledTasks(ctx);
    this.registerCommands(ctx);
  }

  /** 统一的 PageSyncer 构造：数据库在这里装配 */
  private createPageSyncer(ctx: Context): PageSyncer {
    return new PageSyncer(ctx.wikiBot.getGGBot(), ctx.wikiBot.getBWikiBot(), {
      database: ctx.database,
    });
  }

  /**
   * 同步相关的定时任务。
   *
   * 增量同步（页面 + 图片）的 cron 由 `SyncConsole` 持有——它需要支持控制台动态改表达式，
   * 放在这里会和「运行时改 cron」互相打架。这里只保留贡献者这种低频、与增量无关的任务。
   */
  private registerScheduledTasks(ctx: Context) {
    const cron = ctx.oniCron;
    if (typeof cron !== "function") {
      logger.warn("内置 cron 调度器未就绪，定时同步任务已跳过；手动命令不受影响");
      return;
    }

    cron(
      "0 0 2 * * 0",
      async () => {
        logger.info("⏰ 开始执行每周日贡献者同步任务");
        await this.syncAllContributors(ctx, "定时任务");
      },
      "每周日贡献者同步",
    );
    logger.info("✅ 贡献者定时任务已注册（每周日 02:00）；增量同步由「同步运维」面板调度");
  }

  private async ensureBotsReady(
    ctx: Context,
    taskName: string,
  ): Promise<boolean> {
    const { gg, bwiki } = await ctx.wikiBot.ensureReady();

    if (!gg || !bwiki) {
      logger.warn(
        `${taskName} 跳过：Wiki 机器人仍未就绪 - WIKIGG: ${gg ? "✅" : "❌"}, bwiki: ${bwiki ? "✅" : "❌"}`,
      );
      return false;
    }

    return true;
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("sync <pageTitle:string>", "同步指定页面", { authority: 4 })
      .action(async ({ session }, pageTitle) => {
        if (!(await this.ensureBotsReady(ctx, "同步页面"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await this.createPageSyncer(ctx).syncOne(pageTitle, "sync-bot");
          return `✅ 已尝试同步页面：${pageTitle}`;
        } catch (err) {
          logger.error(`同步页面 ${pageTitle} 失败，错误信息：${err}`);
          return `❌ 同步页面失败：${pageTitle}`;
        }
      });

    ctx
      .command("sync.incrementalUpdate", "按水位同步最近的编辑与图片", {
        authority: 1,
      })
      .alias("增量更新")
      .action(async ({ session }) => {
        const result = await ctx.syncConsole.startDelta("command");
        return result.ok
          ? `✅ ${result.message}，详见控制台「同步运维」`
          : `⚠️ ${result.message}`;
      });

    ctx
      .command("sync.status", "查看同步任务状态", { authority: 1 })
      .action(async ({ session }) => {
        const status = ctx.syncConsole.status();
        const stateText: Record<string, string> = {
          idle: "空闲",
          running: "运行中",
          paused: "已暂停",
          stopped: "已停止",
        };
        const nextRun = status.nextDeltaAt
          ? new Date(status.nextDeltaAt).toLocaleString()
          : "未排期";

        const lines = [
          `📊 下次增量同步：${nextRun}（${status.deltaCron}）`,
          status.lastSyncTime ? `水位：${status.lastSyncTime}` : "水位：未设置",
        ];
        for (const task of status.tasks) {
          const progress = task.progress;
          lines.push(
            `${task.label}：${stateText[task.state] ?? task.state}` +
              (task.state === "running" || task.state === "paused"
                ? ` ${progress.phase} ${progress.current}/${progress.total || "?"}`
                : task.lastSummary
                  ? `（${task.lastSummary}）`
                  : ""),
          );
        }
        return lines.join("\n");
      });

    ctx
      .command("sync.allpages", "同步所有页面", { authority: 4 })
      .action(async ({ session }) => {
        if (!(await this.ensureBotsReady(ctx, "同步所有页面"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await this.createPageSyncer(ctx).syncAll();
          return `✅ 已尝试同步所有页面，详见控制台「同步运维」`;
        } catch (err) {
          logger.error(`同步所有页面失败，错误信息：${err}`);
          return `❌ 同步所有页面失败，详见控制台「同步运维」`;
        }
      });

    ctx
      .command("sync.module <moduleTitle:string>", "同步指定模块", {
        authority: 4,
      })
      .action(async ({ session }, moduleTitle) => {
        if (!(await this.ensureBotsReady(ctx, "同步模块"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await new ModuleSyncer(
            ctx.wikiBot.getGGBot(),
            ctx.wikiBot.getBWikiBot(),
          ).syncOne(moduleTitle, "sync-bot");
          return `✅ 已尝试同步模块：${moduleTitle}`;
        } catch (err) {
          logger.error(`同步模块 ${moduleTitle} 失败，错误信息：${err}`);
          return `❌ 同步模块失败：${moduleTitle}`;
        }
      });

    ctx
      .command("sync.allmodules", "同步所有模块", { authority: 4 })
      .action(async ({ session }) => {
        if (!(await this.ensureBotsReady(ctx, "同步所有模块"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await new ModuleSyncer(
            ctx.wikiBot.getGGBot(),
            ctx.wikiBot.getBWikiBot(),
          ).syncAll();
          return `✅ 已尝试同步所有模块，详见控制台「同步运维」`;
        } catch (err) {
          logger.error(`同步所有模块失败，错误信息：${err}`);
          return `❌ 同步所有模块失败，详见控制台「同步运维」`;
        }
      });

    ctx
      .command("sync.img <imgTitle:string>", "同步指定图片", { authority: 4 })
      .action(async ({ session }, imgTitle) => {
        if (!(await this.ensureBotsReady(ctx, "同步图片"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await new ImageSyncer(
            ctx.wikiBot.getGGBot(),
            ctx.wikiBot.getBWikiBot(),
          ).syncOne(
            `${imgTitle.startsWith("File:") ? "" : "File:"}${imgTitle}`,
          );
          return `✅ 已尝试同步图片：${imgTitle}`;
        } catch (err) {
          logger.error(`同步图片 ${imgTitle} 失败，错误信息：${err}`);
          return `❌ 同步图片失败：${imgTitle}`;
        }
      });

    ctx
      .command("sync.allimgs", "同步所有图片", { authority: 4 })
      .action(async ({ session }) => {
        if (!(await this.ensureBotsReady(ctx, "同步所有图片"))) {
          return "❌ Wiki 机器人未就绪，请检查登录配置或查看日志";
        }
        try {
          await new ImageSyncer(
            ctx.wikiBot.getGGBot(),
            ctx.wikiBot.getBWikiBot(),
          ).syncAll();
          return `✅ 已尝试同步所有图片，详见控制台「同步运维」`;
        } catch (err) {
          logger.error(`同步所有图片失败，错误信息：${err}`);
          return `❌ 同步所有图片失败，详见控制台「同步运维」`;
        }
      });

    ctx
      .command("sync.contributor <title:text>", "同步页面的贡献者", {
        authority: 4,
      })
      .action(async ({ session }, title) => {
        return this.syncSingleContributor(ctx, title);
      });

    ctx
      .command("sync.allcontributors", "同步所有页面的贡献者", { authority: 4 })
      .action(async ({ session }) => {
        return this.syncAllContributors(ctx, "手动命令");
      });
  }

  private async getContributorsAndTimestamp(title: string, sourceBot: Mwn) {
    if (!title) return { contributor: "", change_time: "" };

    try {
      const res = await sourceBot.request({
        action: "query",
        format: "json",
        prop: "revisions",
        titles: title,
        formatversion: "2",
        rvprop: "timestamp|user",
      });

      const page = res.query?.pages?.[0];
      if (!page || page.missing === true) {
        return { contributor: "", change_time: "" };
      }

      const revisions = page.revisions?.[0];
      if (!revisions) {
        return { contributor: "", change_time: "" };
      }
      return {
        contributor: revisions.user,
        change_time: formatWikiTime(revisions.timestamp),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[同步贡献者] ❌ 处理 ${title} 时出错: ${errorMsg}`);
      return { contributor: "", change_time: "" };
    }
  }

  private async syncSingleContributor(
    ctx: Context,
    title: string,
  ): Promise<string> {
    try {
      if (!ctx.wikiBot.isReady) {
        const msg = "❌ WikiBot 服务尚未就绪，请稍后重试";
        logger.warn(`[单页同步] ${msg}`);
        return msg;
      }

      if (!ctx.wikiBot.isGGBotReady()) {
        const msg = "❌ WIKIGG Bot 尚未就绪";
        logger.warn(`[单页同步] ${msg}`);
        return msg;
      }

      logger.info(`[单页同步] 开始处理页面: ${title}`);

      const data = await this.getContributorsAndTimestamp(
        title,
        ctx.wikiBot.getGGBot(),
      );

      if (!data.contributor || data.contributor === "") {
        const msg = `❌ 页面 "${title}" 不存在或未被编辑`;
        logger.warn(`[单页同步] ${msg}`);
        return msg;
      }

      await ctx.database.set(
        "wikipages",
        { title },
        {
          contributor: data.contributor,
          change_time: data.change_time,
        },
      );

      const successMsg = `✅ 页面 ${title} 的贡献者已同步为：${data.contributor}，时间：${data.change_time}`;
      logger.info(`[单页同步] ${successMsg}`);
      return successMsg;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const msg = `❌ 同步页面 "${title}" 的贡献者失败: ${errorMsg}`;
      logger.error(`[单页同步] ${msg}`);
      return msg;
    }
  }

  private async syncAllContributors(
    ctx: Context,
    source: string,
  ): Promise<string> {
    try {
      if (!ctx.wikiBot.isReady) {
        const msg = "❌ WikiBot 服务尚未就绪";
        logger.warn(`[${source}] ${msg}`);
        return msg;
      }

      const pages = await ctx.database.get("wikipages", {});
      logger.info(`[${source}] 开始处理 ${pages.length} 个页面`);

      if (pages.length === 0) {
        const msg = "⚠️ 数据库中没有页面数据";
        logger.warn(`[${source}] ${msg}`);
        return msg;
      }

      let successCount = 0;
      let failCount = 0;
      const failedPages: string[] = [];

      for (const page of pages) {
        await sleep(800);
        try {
          const data = await this.getContributorsAndTimestamp(
            page.title,
            ctx.wikiBot.getGGBot(),
          );

          if (data.contributor && data.contributor !== "") {
            await ctx.database.set(
              "wikipages",
              { title: page.title },
              {
                contributor: data.contributor,
                change_time: data.change_time,
              },
            );
            successCount++;
          }
        } catch (err) {
          failCount++;
          const errorMsg = err instanceof Error ? err.message : String(err);
          failedPages.push(page.title);
          logger.error(`[${source}] 页面 ${page.title} 同步失败: ${errorMsg}`);
        }
      }

      const resultMsg = `✅ 同步完成，成功: ${successCount}，失败: ${failCount}`;
      logger.info(`[${source}] ${resultMsg}`);

      if (failedPages.length > 0) {
        logger.warn(`[${source}] 失败页面列表: ${failedPages.join(", ")}`);
      }

      return resultMsg;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const msg = `❌ 同步所有页面贡献者失败: ${errorMsg}`;
      logger.error(`[${source}] ${msg}`);
      return msg;
    }
  }
}
