import { Context, Schema } from "koishi";
import { WikiBotService } from "./services/wikiBotService";
import { ConsoleLogProvider } from "./plugins/consoleLogProvider";
import { DatabaseExtension } from "./plugins/databaseExtension";
import { RouteRedirect } from "./plugins/routeRedirect";
import { SyncCommands } from "./plugins/syncCommands";
import { QueryCommands } from "./plugins/queryCommands";
import { UpdateCommands } from "./plugins/updateCommands";

export const name = "oni-sync-bot";

export interface Config {}

const configSchemas = [
  WikiBotService.Config,
  RouteRedirect.Config,
  SyncCommands.Config,
  QueryCommands.Config,
  UpdateCommands.Config,
];

export const Config: Schema<Config> = Schema.intersect(configSchemas);

export function apply(ctx: Context, config: Config) {
  ctx.plugin(WikiBotService, config);
  ctx.plugin(ConsoleLogProvider);
  ctx.plugin(DatabaseExtension);
  ctx.plugin(RouteRedirect, config);
  ctx.plugin(SyncCommands, config);
  ctx.plugin(QueryCommands, config);
  ctx.plugin(UpdateCommands, config);
}
