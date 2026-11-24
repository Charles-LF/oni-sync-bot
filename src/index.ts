import { Context } from "koishi";
import { resolve } from "path";
import { Config } from "./config";
import { CronService } from "./interface/cronService";
import { WikiBotService } from "./infrastructure/wiki/wikiBotService";
import { DatabaseExtension } from "./infrastructure/persistence/databaseExtension";
import { RouteRedirect } from "./interface/routeRedirect";
import { SyncConsole } from "./interface/syncConsole";
import { AiInsightsConsole } from "./interface/aiInsightsConsole";
import { SyncCommands } from "./interface/syncCommands";
import { QueryCommands } from "./interface/queryCommands";
import { UpdateCommands } from "./interface/updateCommands";
import { AiQueryCommands } from "./interface/aiQueryCommands";

export { Config };

export const name = "oni-sync-bot";

/** 子插件注册表：**顺序即依赖顺序**（CronService 提供 oniCron，DatabaseExtension 先声明数据表） */
const SUB_PLUGINS = [
  CronService,
  DatabaseExtension,
  WikiBotService,
  SyncConsole,
  AiInsightsConsole,
  RouteRedirect,
  SyncCommands,
  QueryCommands,
  UpdateCommands,
  AiQueryCommands,
] as const;

export function apply(ctx: Context, config: Config) {
  for (const plugin of SUB_PLUGINS) {
    ctx.plugin(plugin, config);
  }

  ctx.inject(["console"], (ctx) => {
    ctx.console.addEntry({
      dev: resolve(__dirname, "../client/index.ts"),
      prod: resolve(__dirname, "../dist"),
    });
  });
}
