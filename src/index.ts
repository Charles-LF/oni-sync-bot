import { Context, Schema } from "koishi";
import { resolve } from "path";
import { DataService } from "@koishijs/plugin-console";
import { Mwn } from "mwn";
import { login } from "./core/login";
import { getSitesConfig } from "./siteConfig";

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
  });
}
