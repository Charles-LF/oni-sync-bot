import { Context, Schema } from "koishi";
import { resolve } from "path";
import { DataService } from "@koishijs/plugin-console";
import { Mwn } from "mwn";
import { login } from "./utils/login";
import { getSitesConfig } from "./config";
import { syncPages, syncSinglePage } from "./sync/pageSync";
import { syncModules, syncSingleModule } from "./sync/moduleSync";
import { syncAllImages, syncSingleImage } from "./sync/imgSync";

export const name = "oni-sync-bot";
export const inject = ["console", "database"];

export interface Config {
  ggUsername: string;
  ggPassword: string;
  huijiUsername: string;
  huijiPassword: string;
  huijiUAKey: string;
}

export const Config: Schema<Config> = Schema.object({
  ggUsername: Schema.string()
    .description("WIKIGG 用户名")
    .default("${{ env.ggUsername }}"),
  ggPassword: Schema.string()
    .description("WIKIGG 密码")
    .default("${{ env.ggPassword }}"),
  huijiUsername: Schema.string()
    .description("灰机wiki 用户名")
    .default("${{ env.huijiUsername }}"),
  huijiPassword: Schema.string()
    .description("灰机wiki 密码")
    .default("${{ env.huijiPassword }}"),
  huijiUAKey: Schema.string()
    .description("灰机wiki UAKey")
    .default("${{ env.huijiUAKey }}"),
});

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger("oni-sync-bot");
  let ggbot: Mwn;
  let huijibot: Mwn;
  // 注入控制台
  ctx.inject(["console"], (ctx) => {
    ctx.console.addEntry({
      dev: resolve(__dirname, "../client/index.ts"),
      prod: resolve(__dirname, "../dist"),
    });
  });

  // 插件准备就绪后登录两个账号
  ctx.on("ready", async () => {
    logger.info("初始化中...");
    const sitesConfig = getSitesConfig(config);
    ggbot = await login(sitesConfig.gg);
    huijibot = await login(sitesConfig.huiji);
    if (ggbot.login && huijibot.login) {
      logger.info("登录成功，插件已准备就绪");
    } else {
      logger.error("登录失败，请检查配置");
    }
  });

  // 指令
  //#region 同步单个页面
  ctx
    .command("sync <pageTitle:string>", "同步指定页面", { authority: 2 })
    .action(async ({ session }, pageTitle) => {
      await syncSinglePage(ggbot, huijibot, pageTitle, "sync-bot")
        .then(() => {
          session.send(
            `✅ 已尝试同步页面：${pageTitle}，从 WIKIGG 到 灰机wiki`,
          );
        })
        .catch((err) => {
          session.send(`❌ 同步页面失败：${pageTitle}，错误信息：${err}`);
        });
    });
  // #endregion

  //#region 同步所有页面
  ctx
    .command("sync.allpages", "同步所有页面", { authority: 2 })
    .action(async ({ session }) => {
      session.send(`🚀 开始同步所有页面，任务耗时较长，请耐心等待...`);
      await syncPages(ggbot, huijibot)
        .then(() => {
          session.send(`✅ 已尝试同步所有页面，从 WIKIGG 到 灰机wiki`);
        })
        .catch((err) => {
          session.send(`❌ 同步所有页面失败，错误信息：${err}`);
        });
    });
  // #endregion

  //#region 同步单个模块
  ctx
    .command("sync.module <moduleTitle:string>", "同步指定模块", {
      authority: 2,
    })
    .action(async ({ session }, moduleTitle) => {
      await syncSingleModule(ggbot, huijibot, moduleTitle, "sync-bot")
        .then(() => {
          session.send(
            `✅ 已尝试同步模块：${moduleTitle}，从 WIKIGG 到 灰机wiki`,
          );
        })
        .catch((err) => {
          session.send(`❌ 同步模块失败：${moduleTitle}，错误信息：${err}`);
        });
    });
  // #endregion

  //#region 同步所有模块q
  ctx
    .command("sync.allmodules", "同步所有模块", { authority: 2 })
    .action(async ({ session }) => {
      session.send(`🚀 开始同步所有模块，任务耗时较长，请耐心等待...`);
      await syncModules(ggbot, huijibot)
        .then(() => {
          session.send(`✅ 已尝试同步所有模块，从 WIKIGG 到 灰机wiki`);
        })
        .catch((err) => {
          session.send(`❌ 同步所有模块失败，错误信息：${err}`);
        });
    });
  // #endregion
  // #region 同步单个图片
  ctx
    .command("sync.img <imgTitle:string>", "同步指定图片", { authority: 2 })
    .action(async ({ session }, imgTitle) => {
      await syncSingleImage(
        ggbot,
        huijibot,
        `${imgTitle.startsWith("File:") ? "" : "File:"}${imgTitle}`,
        config,
      )
        .then(() => {
          session.send(`✅ 已尝试同步图片：${imgTitle}`);
        })
        .catch((err) => {
          session.send(`❌ 同步图片失败：${imgTitle}，错误信息：${err}`);
        });
    });
  //#endregion

  // #region 同步所有图片
  ctx
    .command("sync.allimgs", "同步所有图片", { authority: 2 })
    .action(async ({ session }) => {
      session.send(`🚀 开始同步所有图片，任务耗时较长，请耐心等待...`);
      await syncAllImages(ggbot, huijibot, config)
        .then(() => {
          session.send(`✅ 已尝试同步所有图片，从 WIKIGG 到 灰机wiki`);
        })
        .catch((err) => {
          session.send(`❌ 同步所有图片失败，错误信息：${err}`);
        });
    });
  // #endregion
}
