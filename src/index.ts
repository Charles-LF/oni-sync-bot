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

export { Config };

export const name = "oni-sync-bot";

/**
 * 子插件注册表。
 *
 * **顺序即依赖顺序**：`WikiBotService` 必须最先注册，因为它提供的 `wikiBot`
 * 服务被后面的子插件 `inject`。
 *
 * ## 如何新增一个子插件
 *
 * 1. 写一个类，用 `static readonly inject` 声明它依赖哪些服务；
 * 2. 把它加进下面的数组；
 * 3. 如果需要配置，在 `src/config.ts` 的对应分组里补字段
 *    （**不要**新建与已有键重复的字段），再用 `Pick` / `extends` 引用。
 *
 * 配置是所有子插件共享的同一个对象，因此这里统一传 `config`；
 * 不需要配置的子插件会忽略它。
 */
const SUB_PLUGINS = [
  WikiBotService,
  ConsoleLogProvider,
  DatabaseExtension,
  RouteRedirect,
  SyncCommands,
  QueryCommands,
  UpdateCommands,
  TodoList,
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
