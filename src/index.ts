import { Context, Schema } from "koishi";
import {
  WikiBotService,
  WikiBotServiceConfig,
} from "./services/wikiBotService";
import { ConsoleLogProvider } from "./plugins/consoleLogProvider";
import { DatabaseExtension } from "./plugins/databaseExtension";
import { RouteRedirect, RouteRedirectConfig } from "./plugins/routeRedirect";
import { SyncCommands, SyncCommandsConfig } from "./plugins/syncCommands";
import { QueryCommands, QueryCommandsConfig } from "./plugins/queryCommands";
import { UpdateCommands, UpdateCommandsConfig } from "./plugins/updateCommands";

export const name = "oni-sync-bot";

export interface Config
  extends
    WikiBotServiceConfig,
    RouteRedirectConfig,
    SyncCommandsConfig,
    QueryCommandsConfig,
    UpdateCommandsConfig {}

export const Config: Schema<Config> = Schema.intersect([
  WikiBotService.Config,
  RouteRedirect.Config,
  SyncCommands.Config,
  QueryCommands.Config,
  UpdateCommands.Config,
] as const);

export function apply(ctx: Context, config: Config) {
  ctx.plugin(WikiBotService, config);
  ctx.plugin(ConsoleLogProvider);
  ctx.plugin(DatabaseExtension);
  ctx.plugin(RouteRedirect, config);
  ctx.plugin(SyncCommands, config);
  ctx.plugin(QueryCommands, config);
  ctx.plugin(UpdateCommands, config);
}
