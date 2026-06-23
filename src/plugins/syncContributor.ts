import { Context, Logger, sleep } from "koishi";
import { Mwn } from "mwn";
import { formatWikiTime, logger } from "../utils/tools";
import {} from "koishi-plugin-cron";

export interface ContributorConfig {}

export class SyncContributor {
  public static readonly inject = ["wikiBot", "database", "cron"];

  private logger: Logger;
  private ctx: Context;

  constructor(
    ctx: Context,
    private config: ContributorConfig,
  ) {
    this.ctx = ctx;
    this.logger = ctx.logger("【同步贡献者】");
    this.registerCommands(ctx);
    this.setupWeeklySchedule(ctx);
  }

  private setupWeeklySchedule(ctx: Context) {
    ctx.cron("0 0 2 * * 0", async () => {
      this.logger.info("⏰ 开始执行每周日贡献者同步任务");
      await this.executeSyncAllContributors("定时任务");
    });
    this.logger.info("✅ 每周日贡献者定时同步任务已注册（每周日凌晨2点执行）");
  }

  private async executeSyncAllContributors(source: string): Promise<string> {
    try {
      if (!this.ctx.wikiBot.isReady) {
        const msg = "❌ WikiBot 服务尚未就绪";
        this.logger.warn(`[${source}] ${msg}`);
        return msg;
      }

      const pages = await this.ctx.database.get("wikipages", {});
      this.logger.info(`[${source}] 开始处理 ${pages.length} 个页面`);

      if (pages.length === 0) {
        const msg = "⚠️ 数据库中没有页面数据";
        this.logger.warn(`[${source}] ${msg}`);
        return msg;
      }

      let successCount = 0;
      let failCount = 0;
      const failedPages: string[] = [];

      for (const page of pages) {
        await sleep(800);
        try {
          const data = await getContributorsAndTimestamp(
            page.title,
            this.ctx.wikiBot.getGGBot(),
          );

          if (data.contributor && data.contributor !== "") {
            await this.ctx.database.set(
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
          this.logger.error(
            `[${source}] 页面 ${page.title} 同步失败: ${errorMsg}`,
          );
        }
      }

      const resultMsg = `✅ 同步完成，成功: ${successCount}，失败: ${failCount}`;
      this.logger.info(`[${source}] ${resultMsg}`);

      if (failedPages.length > 0) {
        this.logger.warn(`[${source}] 失败页面列表: ${failedPages.join(", ")}`);
      }

      return resultMsg;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const msg = `❌ 同步所有页面贡献者失败: ${errorMsg}`;
      this.logger.error(`[${source}] ${msg}`);
      return msg;
    }
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("synccontributor <title:text>", "同步页面的贡献者", {
        authority: 2,
      })
      .action(async ({ session }, title) => {
        return this.syncSinglePage(title);
      });

    ctx
      .command("synccontributor.all", "同步所有页面的贡献者", { authority: 2 })
      .action(async ({ session }) => {
        return this.executeSyncAllContributors("手动命令");
      });
  }

  private async syncSinglePage(title: string): Promise<string> {
    try {
      if (!this.ctx.wikiBot.isReady) {
        const msg = "❌ WikiBot 服务尚未就绪，请稍后重试";
        this.logger.warn(`[单页同步] ${msg}`);
        return msg;
      }

      if (!this.ctx.wikiBot.isGGBotReady()) {
        const msg = "❌ WIKIGG Bot 尚未就绪";
        this.logger.warn(`[单页同步] ${msg}`);
        return msg;
      }

      this.logger.info(`[单页同步] 开始处理页面: ${title}`);

      const data = await getContributorsAndTimestamp(
        title,
        this.ctx.wikiBot.getGGBot(),
      );

      if (!data.contributor || data.contributor === "") {
        const msg = `❌ 页面 "${title}" 不存在或未被编辑`;
        this.logger.warn(`[单页同步] ${msg}`);
        return msg;
      }

      await this.ctx.database.set(
        "wikipages",
        { title },
        {
          contributor: data.contributor,
          change_time: data.change_time,
        },
      );

      const successMsg = `✅ 页面 ${title} 的贡献者已同步为：${data.contributor}，时间：${data.change_time}`;
      this.logger.info(`[单页同步] ${successMsg}`);
      return successMsg;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const msg = `❌ 同步页面 "${title}" 的贡献者失败: ${errorMsg}`;
      this.logger.error(`[单页同步] ${msg}`);
      return msg;
    }
  }
}

/**
 * 获取页面的贡献者和时间戳
 * @param title 页面标题
 * @param sourceBot Mwn实例
 * @returns 贡献者和时间字符串对象
 */
async function getContributorsAndTimestamp(title: string, sourceBot: Mwn) {
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

    if (res.query.pages[0].missing === true) {
      return { contributor: "", change_time: "" };
    }

    const revisions = res.query.pages[0].revisions[0];
    return {
      contributor: revisions.user,
      change_time: formatWikiTime(revisions.timestamp),
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    this.logger.error(`[同步贡献者] ❌ 处理 ${title} 时出错: ${errorMsg}`);
    return { contributor: "", change_time: "" };
  }
}

export function apply(ctx: Context, config: ContributorConfig) {
  ctx.plugin(SyncContributor, config);
}
