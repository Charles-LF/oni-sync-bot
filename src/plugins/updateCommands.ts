import { Context, Logger, Schema } from "koishi";
import { generatePinyinInfo, logger } from "../utils/tools";

export interface UpdateCommandsConfig {
  logsUrl: string;
}

export class UpdateCommands {
  public static readonly inject = ["database", "wikiBot"];
  public config: UpdateCommandsConfig;
  public log: Logger;

  constructor(ctx: Context, config: UpdateCommandsConfig) {
    this.config = config;
    this.log = ctx.logger("oni-sync");
    this.registerCommands(ctx);
  }

  private registerCommands(ctx: Context) {
    ctx
      .command("update", "更新本地页面缓存（主站）", { authority: 2 })
      .action(async ({ session }) => {
        await session.execute("update.status");
        try {
          const res = await ctx.wikiBot.getGGBot().request({
            action: "query",
            list: "allpages",
            format: "json",
            aplimit: "max",
          });
          logger.info("主站页面查询成功");
          const pages = res.query.allpages || [];

          const pageData = pages.map((page: any) => {
            const { pinyin_full, pinyin_first } = generatePinyinInfo(
              page.title,
            );
            return {
              id: page.pageid,
              title: page.title,
              pinyin_full,
              pinyin_first,
            };
          });

          if (pageData.length > 0) {
            await ctx.database.upsert("wikipages", pageData);
          }

          session.send(`✅ 检索到 ${pages.length} 个页面，已更新至数据库`);
          logger.info(`检索到 ${pages.length} 个页面，已更新至数据库`);
        } catch (err) {
          this.log.error("主站缓存更新失败", err);
          session.send("❌ 主站缓存更新失败，请联系管理员查看日志");
        }
      });

    ctx
      .command("update.delete", "删除本地页面缓存", { authority: 4 })
      .action(async ({ session }) => {
        try {
          const count = await ctx.database.remove("wikipages", {});
          session.send(`✅ 已删除 ${count.removed} 条本地缓存`);
          logger.info(`已删除 ${count.removed} 条本地缓存`);
        } catch (err) {
          this.log.error("删除缓存失败", err);
          session.send("❌ 删除缓存失败，请联系管理员查看日志");
        }
      });

    ctx
      .command("update.status", "查询本地缓存数量", { authority: 1 })
      .action(async ({ session }) => {
        try {
          const pages = await ctx.database.get("wikipages", {});
          session.send(`📊 数据库中缓存了 ${pages.length} 条页面`);
          logger.info(`数据库中缓存了 ${pages.length} 条页面`);
        } catch (err) {
          this.log.error("查询缓存状态失败", err);
          session.send("❌ 查询缓存状态失败，请联系管理员查看日志");
        }
      });

    ctx
      .command("redirect <pageName> <targetPageName>", "添加原站点重定向", {
        authority: 2,
      })
      .alias("重定向")
      .action(async ({ session }, pageName, targetPageName) => {
        if (!pageName || !targetPageName) {
          return "❌ 参数错误！用法：redirect <原页面名> <目标页面名>";
        }
        try {
          await ctx.wikiBot
            .getGGBot()
            .create(
              pageName,
              `#REDIRECT [[${targetPageName}]]`,
              "来自qq机器人的添加重定向页面请求",
            );
          logger.info(`已为 ${pageName} 添加重定向至 ${targetPageName}`);
          session.send(`✅ 已尝试添加重定向 ${pageName} -> ${targetPageName}`);
          await session.execute(`update`);
        } catch (err) {
          this.log.error(
            `添加重定向 ${pageName} -> ${targetPageName} 失败`,
            err,
          );
          session.send(`❌ 添加重定向失败，请联系管理员查看日志`);
        }
      });

    ctx
      .command("relogin", "手动重新登录 Wiki 机器人", { authority: 2 })
      .alias("重新登录")
      .action(async ({ session }) => {
        session.send("🚀 开始重新登录 Wiki 机器人...");
        try {
          const result = await ctx.wikiBot.relogin();
          
          let message = "📋 重新登录结果：\n";
          message += result.gg ? "✅ WIKIGG 登录成功\n" : "❌ WIKIGG 登录失败\n";
          message += result.bwiki ? "✅ bwiki 登录成功\n" : "❌ bwiki 登录失败\n";
          
          if (result.gg && result.bwiki) {
            message += "\n🎉 两个 Wiki 机器人都已成功登录！";
          } else if (result.gg || result.bwiki) {
            message += "\n⚠️  部分 Wiki 机器人已登录";
          } else {
            message += "\n💥 所有 Wiki 机器人登录都失败了，请检查配置";
          }
          
          session.send(message);
        } catch (err) {
          this.log.error("重新登录失败", err);
          session.send("❌ 重新登录过程中发生错误，请查看日志");
        }
      });
  }
}

export namespace UpdateCommands {
  export const Config: Schema<UpdateCommandsConfig> = Schema.object({
    logsUrl: Schema.string()
      .description("日志查看地址")
      .default("https://klei.vip/onilogs"),
  });
}

export function apply(ctx: Context, config: UpdateCommandsConfig) {
  ctx.inject(["wikiBot"], (ctx) => {
    ctx.plugin(UpdateCommands, config);
  });
}
