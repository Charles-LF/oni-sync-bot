import { Context } from "koishi";
import { resolve } from "path";
import { Config } from "./config";
import { WikiBotService } from "./services/wikiBotService";
import { ConsoleLogProvider } from "./services/consoleLogProvider";
import { DatabaseExtension } from "./plugins/databaseExtension";
import { RouteRedirect } from "./plugins/routeRedirect";
import { SyncCommands } from "./plugins/syncCommands";
import { QueryCommands } from "./plugins/queryCommands";
import { UpdateCommands } from "./plugins/updateCommands";
import { TodoList } from "./plugins/todoList";
import { AiQueryCommands } from "./plugins/aiQueryCommands";

export { Config };

export const name = "oni-sync-bot";

/** 子插件注册表：**顺序即依赖顺序**（WikiBotService 必须最先，它提供 wikiBot） */
const SUB_PLUGINS = [
  WikiBotService,
  ConsoleLogProvider,
  DatabaseExtension,
  RouteRedirect,
  SyncCommands,
  QueryCommands,
  UpdateCommands,
  TodoList,
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
